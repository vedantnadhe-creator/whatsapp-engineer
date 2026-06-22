// Per-user voice orchestrator.
//
// A Gemini-powered assistant that knows what the logged-in user is assigned in the
// sprint, and can act on their behalf (start sessions, update sprint items, log
// bugs/subtasks) via natural-language / voice commands. STT is handled by the
// existing /api/transcribe (Deepgram); this module owns the Gemini reasoning loop
// and Deepgram TTS.
//
// The reasoning is provider-agnostic in shape: the caller passes `executors` (the
// actual side-effecting functions, defined where store/messageHandler are in
// scope) so this module stays free of app wiring.

import { GoogleGenAI, Type } from '@google/genai';
import config from './config.js';

let _client = null;
function client() {
    if (!_client) _client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    return _client;
}

// Tool surface the orchestrator can call. Items are matched by title (voice never
// says IDs), so the executor does fuzzy matching against the user's own work.
export const TOOLS = [{
    functionDeclarations: [
        {
            name: 'list_my_work',
            description: "List everything currently assigned to the user in the active sprint (features, subtasks, bugs) with their statuses. Use this to answer 'what do I have to do', 'what's pending', etc.",
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'update_issue_status',
            description: 'Update the dev status and/or QA status of one of the user\'s assigned features/subtasks, matched by title.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    issue_title: { type: Type.STRING, description: 'Title (or close part of it) of the feature/subtask to update.' },
                    dev_status: { type: Type.STRING, description: "New dev status, one of: todo, in_progress, dev_completed, done. Omit to leave unchanged." },
                    qa_status: { type: Type.STRING, description: "New QA status, one of: testing, pass, fail, not_needed. Omit to leave unchanged." },
                },
                required: ['issue_title'],
            },
        },
        {
            name: 'start_session_for_issue',
            description: 'Start (or resume) a Claude coding session for one of the user\'s assigned features/subtasks, matched by title. Optionally include an instruction for what to do this session.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    issue_title: { type: Type.STRING, description: 'Title (or close part) of the feature/subtask to work on.' },
                    instruction: { type: Type.STRING, description: 'Optional extra instruction for the session.' },
                },
                required: ['issue_title'],
            },
        },
        {
            name: 'create_session',
            description: 'Start a brand-new Claude coding session for an ad-hoc task not tied to an existing sprint item.',
            parameters: {
                type: Type.OBJECT,
                properties: { task: { type: Type.STRING, description: 'What the new session should do.' } },
                required: ['task'],
            },
        },
        {
            name: 'add_subtask',
            description: "Add a subtask under one of the user's assigned features, matched by title.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    parent_issue_title: { type: Type.STRING, description: 'Title (or close part) of the parent feature.' },
                    title: { type: Type.STRING, description: 'The subtask title.' },
                },
                required: ['parent_issue_title', 'title'],
            },
        },
        {
            name: 'log_bug',
            description: "Log a QA bug against one of the user's assigned features, matched by title.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    issue_title: { type: Type.STRING, description: 'Title (or close part) of the feature the bug is on.' },
                    title: { type: Type.STRING, description: 'Short description of the bug.' },
                    critical: { type: Type.BOOLEAN, description: 'True if the bug is critical.' },
                },
                required: ['issue_title', 'title'],
            },
        },
    ],
}];

const SYSTEM_PROMPT = `You are the user's personal sprint orchestrator. You speak out loud, so keep replies short, natural and conversational — one or two sentences, no markdown, no lists, no code.

You know exactly what the user is assigned in the current sprint (provided below). When they ask what to do, what's pending, or about their work, answer from that context (or call list_my_work for the freshest view). When they tell you to start working on something, update a status, add a subtask, or log a bug, call the matching tool — match items by the title they say, you don't need exact IDs. After a tool runs, confirm what happened in one short spoken sentence. If a request is ambiguous or you can't find the item, ask a brief clarifying question instead of guessing.`;

// One conversational turn with tool-calling. `executors` maps tool name -> async
// fn(args) -> { ok, result|error, ...}. Returns { reply, actions, history }.
export async function runOrchestratorTurn({ workContext, history = [], userText, executors }) {
    const contents = [
        ...history,
        { role: 'user', parts: [{ text: userText }] },
    ];
    const systemInstruction = `${SYSTEM_PROMPT}\n\n=== THE USER'S CURRENT SPRINT WORK ===\n${workContext || 'No assigned work found.'}`;
    const actions = [];

    // Tool loop — bounded so a misbehaving model can't spin forever.
    for (let hop = 0; hop < 5; hop++) {
        const response = await client().models.generateContent({
            model: config.GEMINI_MODEL,
            contents,
            config: { systemInstruction, tools: TOOLS, temperature: 0.2 },
        });

        const calls = response.functionCalls || [];
        if (!calls.length) {
            const reply = (response.text || '').trim() || "Sorry, I didn't catch that.";
            contents.push({ role: 'model', parts: [{ text: reply }] });
            return { reply, actions, history: contents };
        }

        // Record the model's tool-call turn VERBATIM — Gemini 3 attaches a
        // thought_signature to each functionCall part that must be echoed back, so
        // push the raw content rather than reconstructing it.
        const modelContent = response.candidates?.[0]?.content;
        contents.push(modelContent || { role: 'model', parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })) });
        const responseParts = [];
        for (const call of calls) {
            const exec = executors[call.name];
            let result;
            try { result = exec ? await exec(call.args || {}) : { ok: false, error: `Unknown tool ${call.name}` }; }
            catch (err) { result = { ok: false, error: err.message }; }
            actions.push({ tool: call.name, args: call.args || {}, result });
            responseParts.push({ functionResponse: { name: call.name, response: result } });
        }
        contents.push({ role: 'user', parts: responseParts });
    }

    // Fell through the hop budget — return whatever the last reasoning produced.
    return { reply: 'Done — though that took a few steps. Anything else?', actions, history: contents };
}

// Deepgram TTS → returns an audio Buffer (mp3). Throws on failure so the caller
// can still return the text reply without audio.
export async function synthesizeSpeech(text) {
    const voice = config.DEEPGRAM_TTS_MODEL || 'aura-2-thalia-en';
    const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`, {
        method: 'POST',
        headers: { 'Authorization': `Token ${config.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: (text || '').slice(0, 1800) }),
    });
    if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
}
