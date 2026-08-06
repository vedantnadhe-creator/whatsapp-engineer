// Master agent orchestrator — drives a single Claude "master" session that can
// spawn worker sub-sessions via the `spawn_sub_session` tool.
//
// Why this exists: the prod-deployment agent (and any future multi-step agent)
// is really a *coordinator* — it asks the user scope questions, then dispatches
// worker sessions (changelog, sql, env, infra, deploy), and reports results
// back. We want Claude to do that dispatching itself, not a human clicking
// buttons. The model gets ONE tool — spawn_sub_session — and decides when to
// use it based on the master workflow prompt.
//
// How it works:
//   1. We call the Anthropic Messages API directly (the same /v1/messages the
//      local Ollama proxy speaks, or api.anthropic.com in production). The
//      `claude --print` CLI doesn't expose tool-use round-trips cleanly, so
//      this module is the orchestrator instead.
//   2. We send `tools: [spawn_sub_session]` in every turn. When the model
//      emits a `tool_use` block, we validate the input, call back into the
//      dashboard to create a child session, and feed the result back as a
//      `tool_result` in the next request.
//   3. Streaming is preserved by passing SSE on/off per request and emitting
//      `text` deltas via the `onEvent` callback. The dashboard forwards these
//      to the WebSocket broadcast the same way regular session messages are.
//
// Out of scope: this module never calls the Anthropic API itself in tests;
// runMasterAgent() takes an `apiCall` function in dev so we can mock.

import config from './config.js';

// ── Tool definition ──────────────────────────────────────────────────────────
// Single tool exposed to the master. input_schema deliberately permissive on
// the prompt (master is the boss, it can write the worker prompt) but locked
// down on `agent_id` (must be one of the registered workers under the master
// agent's directory). The dashboard validates `agent_id` against the master
// agent's `workers/` directory before we ever call the tool.

export const SPAWN_TOOL = {
    name: 'spawn_sub_session',
    description:
        'Spawn a worker sub-session to handle a specific step of the agent workflow. ' +
        'Use this whenever the next step of the workflow should be done by a fresh, ' +
        'isolated Claude session with its own context — for example a "changelog" worker ' +
        'that diffs two branches, or a "sql" worker that reviews a database migration. ' +
        'You will receive the worker\'s sessionId back; you can then either keep going ' +
        'in your own conversation or tell the user to chat with the worker directly. ' +
        'Always pass a self-contained `prompt` — the worker does NOT see your conversation.',
    input_schema: {
        type: 'object',
        properties: {
            agent_id: {
                type: 'string',
                description:
                    'Which worker to spawn. Must be one of the worker ids listed in the ' +
                    'workflow file under "## Available workers".',
            },
            prompt: {
                type: 'string',
                description:
                    'A complete, self-contained instruction for the worker. Include all ' +
                    'context the worker needs (e.g. which services, which sprint, which ' +
                    'branches) — the worker cannot see this conversation.',
            },
            name: {
                type: 'string',
                description: 'Optional short label shown in the UI for this worker session.',
            },
        },
        required: ['agent_id', 'prompt'],
    },
};

// ── API endpoint resolution ───────────────────────────────────────────────────
// In production we hit api.anthropic.com with ANTHROPIC_API_KEY. In DEV the
// local Ollama proxy speaks the same protocol at OLLAMA_BASE_URL. We pick the
// right base URL the same way claude_manager.js does so behaviour stays
// consistent with regular sessions.
//
// Both endpoints accept the same Messages API shape (tools, tool_use,
// tool_result, stream). Tested manually with Ollama Cloud models that have
// tool support (gemini-3-flash, gemma4, minimax-m3, kimi-k2.5 etc.).

function resolveApi() {
    const explicit = process.env.ANTHROPIC_API_URL;
    if (explicit) {
        return {
            baseUrl: explicit.replace(/\/+$/, ''),
            apiKey: process.env.ANTHROPIC_API_KEY || '',
            isOllama: false,
        };
    }
    // Default: use the same Ollama proxy Claude Code would use, so master
    // sessions never burn Anthropic quota. To force real Anthropic, set
    // ANTHROPIC_API_URL=https://api.anthropic.com in the daemon env.
    return {
        baseUrl: (config.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, ''),
        apiKey: process.env.ANTHROPIC_API_KEY || config.OLLAMA_AUTH_TOKEN || 'ollama',
        isOllama: true,
    };
}

// ── Stream accumulator ───────────────────────────────────────────────────────
// Anthropic SSE looks like `event: content_block_delta\ndata: {"delta":{"text":"hi"}}`.
// We collect all `text` deltas and return them at the end. We do NOT stream
// to the client here — the caller (dashboard) decides when to flush, because
// tool-use messages often interleave with text and we don't want to commit
// half-sentences to the session store.
//
// For Ollama's /v1/messages (Anthropic-compat) the wire format is the same
// except `event:` line uses lowercase names; we accept both.

function parseSseBlock(block) {
    let event = 'message';
    let data = null;
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
            const d = line.slice(5).trim();
            if (d && d !== '[DONE]') {
                try { data = JSON.parse(d); } catch { /* skip */ }
            }
        }
    }
    return { event, data };
}

// Stream a single Messages request. Yields {type, ...} events:
//   {type:'text', text}              text delta
//   {type:'tool_use', id, name, input}  complete tool call (after stream end)
//   {type:'message_stop', stop_reason}  end of assistant turn
//   {type:'usage', input_tokens, output_tokens}
//   {type:'error', message}
async function* streamMessages({ model, system, messages, maxTokens = 4096, tools = [SPAWN_TOOL] }) {
    const api = resolveApi();
    const res = await fetch(`${api.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': api.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            tools,
            messages,
            stream: true,
        }),
    });
    if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        yield { type: 'error', message: `Messages API ${res.status}: ${txt.slice(0, 500)}` };
        return;
    }

    // Buffer raw text by event type, then emit content blocks when stream ends.
    // This matches the Anthropic wire format: content_block_start, deltas, stop.
    const blocks = [];          // current content blocks being assembled
    let stopReason = null;
    let usage = null;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const raw of events) {
            const { event, data } = parseSseBlock(raw);
            if (!data) continue;
            if (event === 'content_block_start' && data.content_block) {
                blocks.push({ ...data.content_block, _textSoFar: '' });
                if (data.content_block.type === 'tool_use') {
                    // mark so we can flush later
                    blocks[blocks.length - 1]._inputJson = '';
                }
            } else if (event === 'content_block_delta' && data.delta) {
                const blk = blocks[data.index];
                if (!blk) continue;
                if (data.delta.type === 'text_delta') {
                    blk._textSoFar += data.delta.text || '';
                    yield { type: 'text', text: data.delta.text || '' };
                } else if (data.delta.type === 'input_json_delta') {
                    blk._inputJson = (blk._inputJson || '') + (data.delta.partial_json || '');
                } else if (data.delta.type === 'thinking_delta') {
                    // ignore extended-thinking for now
                }
            } else if (event === 'message_delta' && data.delta) {
                if (data.delta.stop_reason) stopReason = data.delta.stop_reason;
                if (data.usage) usage = { ...usage, ...data.usage };
            } else if (event === 'message_stop') {
                // finalized
            } else if (event === 'error' || data?.error) {
                yield { type: 'error', message: data?.error?.message || 'stream error' };
            }
        }
    }

    // Finalize blocks — emit tool_use events for any tool blocks we collected.
    for (const blk of blocks) {
        if (blk.type === 'tool_use') {
            let input = {};
            try { input = blk._inputJson ? JSON.parse(blk._inputJson) : {}; } catch { /* bad json */ }
            yield { type: 'tool_use', id: blk.id, name: blk.name, input };
        }
    }
    yield { type: 'message_stop', stop_reason: stopReason, usage };
}

// ── runMasterAgent ───────────────────────────────────────────────────────────
// The main entry point. Drives one master turn (or many) and yields events.
// The caller (dashboard) is responsible for:
//   - persisting yielded text into the session store + broadcasting
//   - persisting yielded tool_use events for the audit log
//   - calling `spawnChild()` (passed in) when it sees a spawn_sub_session tool
//   - building the `tool_result` message from the spawnChild return value
//   - calling runMasterAgent again to continue the conversation
//
// Returned shape: {events: AsyncIterable, final: {stop_reason, usage, blocks}}
//   `events` yields the per-event stream; `final` is resolved when the turn
//   is done (end_turn, max_tokens, or after all tool calls handled).
export async function runMasterAgent({
    model,
    system,
    messages,
    maxTokens = 4096,
    onText,           // (text: string) => void
    onToolUse,        // (tool: {id, name, input}) => Promise<{content: string, isError?: boolean}>
}) {
    const events = [];
    let finalBlocks = [];
    let stopReason = null;
    let usage = null;
    let errored = null;

    // Single-turn loop: stream, accumulate, on tool_use call handler, append
    // tool_result to messages, loop again. Stops on end_turn, max_tokens, or
    // any non-tool_use stop reason.
    const conversationMessages = [...messages];
    for (let turn = 0; turn < 8; turn++) { // safety cap on consecutive tool turns
        const assistantContent = [];
        const seenTextForThisTurn = [];
        for await (const ev of streamMessages({ model, system, messages: conversationMessages, maxTokens })) {
            events.push(ev);
            if (ev.type === 'text') {
                assistantContent.push({ type: 'text', text: ev.text });
                if (onText) seenTextForThisTurn.push(ev.text);
            } else if (ev.type === 'tool_use') {
                assistantContent.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
                const isError = !ev.name || ev.name !== 'spawn_sub_session';
                let toolResultContent;
                try {
                    const result = onToolUse ? await onToolUse(ev) : { content: 'no handler' };
                    toolResultContent = result?.content ?? '';
                    if (result?.isError) {
                        // Anthropic wants is_error as a sibling to content, not in it
                        conversationMessages.push({ role: 'assistant', content: assistantContent });
                        conversationMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.id, is_error: true, content: toolResultContent || 'tool error' }] });
                        errored = 'tool_error';
                        break;
                    }
                } catch (e) {
                    conversationMessages.push({ role: 'assistant', content: assistantContent });
                    conversationMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.id, is_error: true, content: String(e?.message || e) }] });
                    errored = 'tool_threw';
                    break;
                }
                conversationMessages.push({ role: 'assistant', content: assistantContent });
                conversationMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: ev.id, content: toolResultContent }] });
                // Drain the inner turn loop — we'll start a new outer turn that
                // streams the next assistant message.
                assistantContent.length = 0;
                finalBlocks = [];
                stopReason = null;
                usage = null;
                continue; // next outer turn
            } else if (ev.type === 'message_stop') {
                stopReason = ev.stop_reason;
                if (ev.usage) usage = { ...usage, ...ev.usage };
            } else if (ev.type === 'error') {
                errored = ev.message;
                break;
            }
        }
        if (errored) break;
        // No more tool calls in this turn — we got end_turn (or max_tokens).
        if (assistantContent.length && !events.find(e => e.type === 'tool_use' && events.indexOf(e) >= events.length - 5)) {
            // already pushed
        }
        if (seenTextForThisTurn.length && onText) {
            // already streamed; the caller will have captured incrementally
        }
        break;
    }

    return {
        events,
        final: { stop_reason: stopReason, usage, error: errored },
        messages: conversationMessages,
    };
}

export const __test = { parseSseBlock, resolveApi };
