// ============================================================
// orchestrator.js — Gemini intent classifier + session router
// ============================================================
//
// Gemini's ONLY job here:
//   1. Classify user intent (start/resume/stop/list/status/chat)
//   2. Summarize Claude's long output for WhatsApp
//   3. Maintain per-user conversation history (so it knows context)
//
// Thinking budget is set LOW — classification is simple,
// no need for heavy reasoning. Keeps latency fast.
// ============================================================

import { GoogleGenAI } from '@google/genai';
import config from './config.js';

const DEFAULT_SYSTEM_PROMPT = `You are an AI session manager for a WhatsApp-based coding assistant. Your job is to understand the user's intent and decide what action to take.

Claude (the coding AI) has access to these MCP tools and can use them autonomously:
- **browser-agent**: Browse websites, search the web, scrape pages
- **github**: Read repos, create PRs, search code, view issues
- **jira**: Create/update/search Jira tickets
- **notion**: Read/write Notion pages and databases
- **postgres**: Run SQL queries directly on the database

Because of these tools, ANY request involving research, web search, database queries, fetching data, or looking something up should go to Claude via START_SESSION — not CHAT.

CRITICAL RULES FOR THREAD MANAGEMENT:
1. Each user has ONE active thread (session) at a time.
2. If a thread is OPEN, you MUST MUST MUST respond with RESUME_SESSION for ANY coding request, follow-up, or question. Do NOT assume a new request means a new session. 
3. You should ONLY respond with START_SESSION if there is NO open thread, OR if the user explicitly says words like "new task", "start fresh", "ignore previous".
4. If a user provides a session ID like "WA-1234", use RESUME_SESSION with that ID in the session_ref field.

You can perform these actions:
1. START_SESSION - Start a brand new task. Only use when: NO thread is open, OR user explicitly says "new task" / "start fresh".
2. PLAN_SESSION - Plan a task first before executing.
3. RESUME_SESSION - Send a follow-up to an existing session. MUST BE USED IF A THREAD IS CURRENTLY OPEN or if the user mentions a specific session ID.
4. STOP_SESSION - Stop/kill a currently RUNNING session. (e.g., "stop", "cancel")
5. CLOSE_SESSION - Close the current thread so the next message starts fresh. (e.g., "done", "close", "wrap up")
6. LIST_SESSIONS - User wants to see their session history.
7. STATUS - User wants to check the status of running sessions.
8. GET_COST - Check total API spend.
9. CHAT - Small talk or greetings. Do NOT use for coding tasks.

Respond ONLY with a JSON object in this exact format:
{
  "action": "START_SESSION" | "PLAN_SESSION" | "RESUME_SESSION" | "STOP_SESSION" | "CLOSE_SESSION" | "LIST_SESSIONS" | "STATUS" | "GET_COST" | "CHAT",
  "task": "the coding task or follow-up message (for START_SESSION, PLAN_SESSION, RESUME_SESSION)",
  "session_ref": "session ID or description if mentioned",
  "reply": "a brief, friendly message to send back to the user"
}

Rules:
- THREAD IS OPEN = use RESUME_SESSION for ALMOST EVERYTHING unless explicitly told to close/start fresh.
- "go ahead", "proceed", "yes", "continue", "resume" → RESUME_SESSION
- "search", "look up", "query" → RESUME_SESSION (if open) or START_SESSION (if closed).
- "done", "close", "start fresh" → CLOSE_SESSION
- "stop", "cancel" → STOP_SESSION
- "cost", "spend" → GET_COST
- Keep your "reply" concise and friendly (1-2 sentences max)
- If the user is just asking to switch/resume a session (e.g. "resume WA-123") without providing an actual coding prompt, set "task" to an empty string ("").
- Otherwise, put the FULL user message in "task" — do not modify it`;

class Orchestrator {
    constructor(store = null) {
        this.client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
        this.store = store;

        // Load system prompt from DB (if available), fallback to default
        this.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        this._loadPromptFromDB();

        // Per-user conversation history for Gemini.
        // Stored as Gemini-native format: [{ role: 'user'|'model', parts: [{ text }] }]
        // This is passed as the `contents` array so Gemini has full context across messages.
        this.userHistory = new Map();
    }

    _loadPromptFromDB() {
        if (!this.store) return;
        try {
            const row = this.store.getSystemPrompt('orchestrator');
            if (row?.prompt) {
                this.systemPrompt = row.prompt;
                console.log('[Orchestrator] Loaded custom system prompt from DB');
            }
        } catch (err) {
            console.error('[Orchestrator] Failed to load prompt from DB, using default:', err.message);
        }
    }

    /** Reload system prompt from DB (called after admin updates it) */
    reloadPrompt() {
        this._loadPromptFromDB();
    }

    // ── Local fast-path: bypass Gemini for obvious commands ───
    // This keeps latency near-instant for simple intents.
    _fastPath(message, currentThread) {
        const t = message.trim().toLowerCase();

        // Resume by session ID (e.g. "WA-abc123 resume this")
        const waId = message.match(/WA-[a-z0-9\-]+/i)?.[0];
        if (waId && /resume|continue|pick up|go back/i.test(t)) {
            return { action: 'RESUME_SESSION', task: t.replace(/WA-[a-z0-9\-]+/gi, '').trim() || '', session_ref: waId, reply: `🔄 Resuming *${waId}*...` };
        }

        // List sessions (Strictly slash command only)
        if (/^\/sessions(\s|$)/i.test(t)) {
            return { action: 'LIST_SESSIONS', task: '', session_ref: null, reply: '' };
        }

        // Status
        if (/^(status|what.?s running|running sessions?)(\s|$)/i.test(t)) {
            return { action: 'STATUS', task: '', session_ref: null, reply: '' };
        }

        // Cost
        if (/^(cost|spend|how much|total cost)(\s|$)/i.test(t)) {
            return { action: 'GET_COST', task: '', session_ref: null, reply: '' };
        }

        // Stop session
        if (/^(stop|kill|cancel)(\s|$)/i.test(t)) {
            return { action: 'STOP_SESSION', task: '', session_ref: null, reply: '🛑 Stopping...' };
        }

        // Close thread (Only if the message is exactly these words to avoid catching "[start fresh] some task")
        if (/^(done|close|finished|wrap up|that.?s all)$/i.test(t)) {
            return { action: 'CLOSE_SESSION', task: '', session_ref: null, reply: '✅ Thread closed.' };
        }

        // If thread is open and no session-management keyword, treat as follow-up
        if (currentThread && !/new (session|task)|start fresh|ignore previous/i.test(t)) {
            return { action: 'RESUME_SESSION', task: message, session_ref: currentThread.id, reply: '🔄 Sending to your active session...' };
        }

        return null; // No fast-path match → use Gemini
    }

    async classify(userPhone, message, activeSessions = [], currentThread = null) {
        // ── Fast-path: instant local classification for obvious commands ──
        const fast = this._fastPath(message, currentThread);
        if (fast) {
            console.log(`[Orchestrator] Fast-path: ${fast.action}`);
            return fast;
        }

        // Thread context — tells Gemini whether a session is already open
        const threadContext = currentThread
            ? `\n\nOPEN THREAD: Session ${currentThread.id} | task: "${currentThread.task?.slice(0, 80)}" | status: ${currentThread.status}. Send follow-ups to this session unless user explicitly wants a new task.`
            : '\n\nNO OPEN THREAD: No active thread. Start a new session for any task.';

        const runningContext = activeSessions.length > 0
            ? `\nRunning sessions: ${activeSessions.map(s => `${s.id} ("${s.task?.slice(0, 60)}")` ).join(', ')}`
            : '';

        const userText = `${message}${threadContext}${runningContext}\n\nRespond with JSON only.`;

        // Get this user's history (Gemini multi-turn conversation format)
        const history = this.userHistory.get(userPhone) || [];

        try {
            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                // Pass full conversation history + current message as contents array
                contents: [
                    ...history,
                    { role: 'user', parts: [{ text: userText }] }
                ],
                config: {
                    systemInstruction: this.systemPrompt,
                    responseMimeType: 'application/json',
                    temperature: 0.1,
                    // Low thinking budget — intent classification is simple,
                    // doesn't need deep reasoning. Keeps latency fast.
                    thinkingConfig: {
                        thinkingBudget: 512,   // tokens. 0 = disabled, max = 24576
                    },
                },
            });

            const text = response.text?.trim() || '{}';
            const result = JSON.parse(text);

            // Store this exchange in history for next turn
            const updatedHistory = [
                ...history,
                { role: 'user', parts: [{ text: userText }] },
                { role: 'model', parts: [{ text }] },
            ];
            // Keep last 20 turns (40 entries) to avoid token bloat
            const maxEntries = 40;
            if (updatedHistory.length > maxEntries) {
                updatedHistory.splice(0, updatedHistory.length - maxEntries);
            }
            this.userHistory.set(userPhone, updatedHistory);

            return result;
        } catch (err) {
            console.error('[Orchestrator] Classification error:', err.message);
            // Default: treat everything as a new session task
            return {
                action: 'START_SESSION',
                task: message,
                session_ref: null,
                reply: "I'll start working on that right away! 🚀",
            };
        }
    }

    /**
     * Summarize long Claude output for WhatsApp.
     * Uses a separate stateless call — no history needed here.
     */
    async summarize(rawOutput, maxLength = 3500) {
        if (!rawOutput || rawOutput.length <= maxLength) return rawOutput;

        try {
            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: `Summarize this Claude Code output concisely for a WhatsApp message. Focus on: what was done, files changed, errors, final result. Be brief:\n\n${rawOutput.slice(0, 8000)}`,
                config: {
                    temperature: 0.1,
                    thinkingConfig: { thinkingBudget: 512 },  // Use minimal budget for recap/summarization
                },
            });
            return (response.text || '').slice(0, maxLength);
        } catch (err) {
            console.error('[Orchestrator] Summarize error:', err.message);
            return rawOutput.slice(0, maxLength) + '\n...(truncated)';
        }
    }

    /**
     * Generate a very brief recap of previous session progress based on chat history.
     */
    async recap(messages) {
        if (!messages || messages.length === 0) return "";
        try {
            const context = messages
                .filter(m => m.role === 'assistant')
                .slice(-5)
                .map(m => m.content)
                .join("\n\n---\n\n");

            if (!context) return "";

            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: `Review these previous assistant messages and provide a 1-2 sentence summary of progress so far. This will be shown to the user as they "resume" the session. Be extremely brief and professional:\n\n${context.slice(-6000)}`,
                config: {
                    temperature: 0.1,
                    thinkingConfig: { thinkingBudget: 512 },
                },
            });
            return response.text?.trim() || "";
        } catch (err) {
            console.error('[Orchestrator] Recap error:', err.message);
            return "";
        }
    }

    /**
     * Clear history for a user (e.g. after a long idle period).
     */
    clearHistory(userPhone) {
        this.userHistory.delete(userPhone);
    }
}

export { DEFAULT_SYSTEM_PROMPT };
export default Orchestrator;
