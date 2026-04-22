// ============================================================
// orchestrator.js — Gemini intent classifier + session router
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
2. If a thread is OPEN, you MUST MUST MUST respond with RESUME_SESSION for ANY coding request, follow-up, or question.
3. You should ONLY respond with START_SESSION if there is NO open thread, OR if the user explicitly says words like "new task", "start fresh", "ignore previous".
4. If a user provides a session ID like "WA-1234", use RESUME_SESSION with that ID in the session_ref field.

Actions:
1. START_SESSION - Start a brand new task.
2. PLAN_SESSION - Plan a task first before executing.
3. RESUME_SESSION - Send a follow-up to an existing session.
4. STOP_SESSION - Stop/kill a currently RUNNING session.
5. CLOSE_SESSION - Close the current thread so the next message starts fresh.
6. LIST_SESSIONS - User wants to see their session history.
7. STATUS - User wants to check the status of running sessions.
8. GET_COST - Check total API spend.
9. CHAT - Small talk or greetings only.

Respond ONLY with a JSON object:
{
  "action": "START_SESSION" | "PLAN_SESSION" | "RESUME_SESSION" | "STOP_SESSION" | "CLOSE_SESSION" | "LIST_SESSIONS" | "STATUS" | "GET_COST" | "CHAT",
  "task": "the coding task or follow-up message",
  "session_ref": "session ID or description if mentioned",
  "reply": "a brief, friendly message to send back to the user"
}`;

class Orchestrator {
    constructor(store = null) {
        this.client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
        this.store = store;
        this.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        this._loadPromptFromDB();
        this.userHistory = new Map();
    }

    _loadPromptFromDB() {
        if (!this.store) return;
        try {
            const row = this.store.getSystemPrompt('orchestrator');
            if (row?.prompt) this.systemPrompt = row.prompt;
        } catch (err) {
            console.error('[Orchestrator] Failed to load prompt from DB:', err.message);
        }
    }

    reloadPrompt() { this._loadPromptFromDB(); }

    _fastPath(message, currentThread) {
        const t = message.trim().toLowerCase();
        const waId = message.match(/WA-[a-z0-9\-]+/i)?.[0];
        if (waId && /resume|continue|pick up|go back/i.test(t)) {
            return { action: 'RESUME_SESSION', task: t.replace(/WA-[a-z0-9\-]+/gi, '').trim() || '', session_ref: waId, reply: `Resuming ${waId}...` };
        }
        if (/^\/sessions(\s|$)/i.test(t)) return { action: 'LIST_SESSIONS', task: '', session_ref: null, reply: '' };
        if (/^(status|what.?s running|running sessions?)(\s|$)/i.test(t)) return { action: 'STATUS', task: '', session_ref: null, reply: '' };
        if (/^(cost|spend|how much|total cost)(\s|$)/i.test(t)) return { action: 'GET_COST', task: '', session_ref: null, reply: '' };
        if (/^(stop|kill|cancel)(\s|$)/i.test(t)) return { action: 'STOP_SESSION', task: '', session_ref: null, reply: 'Stopping...' };
        if (/^(done|close|finished|wrap up|that.?s all)$/i.test(t)) return { action: 'CLOSE_SESSION', task: '', session_ref: null, reply: 'Thread closed.' };
        if (currentThread && !/new (session|task)|start fresh|ignore previous/i.test(t)) {
            return { action: 'RESUME_SESSION', task: message, session_ref: currentThread.id, reply: 'Sending to your active session...' };
        }
        return null;
    }

    async classify(userPhone, message, activeSessions = [], currentThread = null) {
        const fast = this._fastPath(message, currentThread);
        if (fast) return fast;

        const threadContext = currentThread
            ? `\n\nOPEN THREAD: Session ${currentThread.id} | task: "${currentThread.task?.slice(0, 80)}" | status: ${currentThread.status}.`
            : '\n\nNO OPEN THREAD: No active thread.';

        const runningContext = activeSessions.length > 0
            ? `\nRunning sessions: ${activeSessions.map(s => `${s.id} ("${s.task?.slice(0, 60)}")`) .join(', ')}`
            : '';

        const userText = `${message}${threadContext}${runningContext}\n\nRespond with JSON only.`;
        const history = this.userHistory.get(userPhone) || [];

        try {
            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: [...history, { role: 'user', parts: [{ text: userText }] }],
                config: {
                    systemInstruction: this.systemPrompt,
                    responseMimeType: 'application/json',
                    temperature: 0.1,
                    thinkingConfig: { thinkingBudget: 512 },
                },
            });

            const text = response.text?.trim() || '{}';
            const result = JSON.parse(text);

            const updatedHistory = [...history, { role: 'user', parts: [{ text: userText }] }, { role: 'model', parts: [{ text }] }];
            if (updatedHistory.length > 40) updatedHistory.splice(0, updatedHistory.length - 40);
            this.userHistory.set(userPhone, updatedHistory);

            return result;
        } catch (err) {
            console.error('[Orchestrator] Classification error:', err.message);
            return { action: 'START_SESSION', task: message, session_ref: null, reply: "I'll start working on that right away!" };
        }
    }

    async summarize(rawOutput, maxLength = 3500) {
        if (!rawOutput || rawOutput.length <= maxLength) return rawOutput;
        try {
            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: `Summarize this Claude Code output concisely for a WhatsApp message. Focus on: what was done, files changed, errors, final result. Be brief:\n\n${rawOutput.slice(0, 8000)}`,
                config: { temperature: 0.1, thinkingConfig: { thinkingBudget: 512 } },
            });
            return (response.text || '').slice(0, maxLength);
        } catch (err) {
            return rawOutput.slice(0, maxLength) + '\n...(truncated)';
        }
    }

    async recap(messages) {
        if (!messages || messages.length === 0) return "";
        try {
            const context = messages.filter(m => m.role === 'assistant').slice(-5).map(m => m.content).join("\n\n---\n\n");
            if (!context) return "";
            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: `Review these previous assistant messages and provide a 1-2 sentence summary of progress so far:\n\n${context.slice(-6000)}`,
                config: { temperature: 0.1, thinkingConfig: { thinkingBudget: 512 } },
            });
            return response.text?.trim() || "";
        } catch (err) { return ""; }
    }

    clearHistory(userPhone) { this.userHistory.delete(userPhone); }

    /**
     * Analyze a completed session's conversation to extract learnings.
     * Returns a string with new learnings, or empty string if nothing noteworthy.
     */
    async extractLearnings(task, messages, costUsd, status) {
        if (!messages || messages.length < 3) return '';
        try {
            // Build a condensed conversation log
            const convo = messages.slice(-30).map(m => {
                let content = (m.content || '').replace(/<!--thinking-->[\s\S]*?<!--\/thinking-->\n?\n?/g, '').trim();
                if (content.length > 800) content = content.slice(0, 800) + '...';
                return `[${m.role}]: ${content}`;
            }).join('\n\n');

            const prompt = `You are analyzing a completed coding session to extract learnings for future sessions.

Task: ${task || 'Unknown'}
Status: ${status}
Cost: $${Number(costUsd || 0).toFixed(4)}
Message count: ${messages.length}

Conversation (condensed):
${convo.slice(0, 12000)}

---

Look for these patterns:
1. **Wasted iterations** — Did the bot try something multiple times before getting it right? What should it know upfront?
2. **Config/env gotchas** — Were there environment, config, or infra issues that required trial-and-error to discover?
3. **Wrong approach first** — Did the bot take a wrong approach and have to backtrack? What's the faster path?
4. **Missing knowledge** — Was there domain knowledge the bot didn't have that would have helped?
5. **Common patterns** — Are there project-specific patterns/conventions that should be documented?

IMPORTANT:
- Only return learnings that would help FUTURE sessions avoid the same issues
- Do NOT include learnings about deployment rules (already handled separately)
- Do NOT include generic programming advice — only project-specific insights
- If the session went smoothly with no issues, respond with exactly: NONE
- Keep each learning to 1-2 sentences max
- Format as a bullet list starting with "- "

Response:`;

            const response = await this.client.models.generateContent({
                model: config.GEMINI_MODEL,
                contents: prompt,
                config: { temperature: 0.1, thinkingConfig: { thinkingBudget: 1024 } },
            });

            const text = (response.text || '').trim();
            if (!text || text === 'NONE' || text.toLowerCase().includes('no notable learnings')) return '';
            return text;
        } catch (err) {
            console.error('[Orchestrator] Learning extraction failed:', err.message);
            return '';
        }
    }
}

export { DEFAULT_SYSTEM_PROMPT };
export default Orchestrator;
