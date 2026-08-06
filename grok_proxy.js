// Local Anthropic Messages <-> xAI (OpenAI-compatible) translation proxy.
//
// Claude Code CLI (the `claude` binary) speaks the Anthropic Messages API only.
// xAI's Grok API is OpenAI chat-completions schema. This mounts
// POST /grok/v1/messages inside the dashboard's Express app; grok_models.js
// points ANTHROPIC_BASE_URL at it for `grok:`-tagged sessions. Auth: the spawned
// `claude` process sends config.GROK_PROXY_TOKEN as x-api-key (via
// ANTHROPIC_AUTH_TOKEN) — the real xAI key is injected here server-side and never
// reaches the client process, its env, or its on-disk transcript.
//
// ponytail: handles text + tool_use/tool_result + basic image blocks only. No
// extended-thinking passthrough (xAI has no equivalent block type in this API)
// and prompt-cache_control is accepted but ignored. Upgrade path: add
// thinking-block passthrough if xAI later exposes reasoning traces here.

import { Readable } from 'stream';
import config from './config.js';

const randomId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const sanitizeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_') || randomId('toolu');

function normalizeSystem(system) {
    if (!system) return null;
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
    return null;
}

function toolResultToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? '');
    return content.map((b) => (b?.type === 'text' ? b.text : `[${b?.type || 'block'}]`)).join('\n');
}

function imageBlockToDataUrl(block) {
    const src = block?.source;
    if (!src) return null;
    if (src.type === 'base64') return `data:${src.media_type};base64,${src.data}`;
    if (src.type === 'url') return src.url;
    return null;
}

// Anthropic (system, messages[]) -> OpenAI chat.completions messages[].
function toOpenAIMessages(system, messages) {
    const out = [];
    const sys = normalizeSystem(system);
    if (sys) out.push({ role: 'system', content: sys });
    for (const m of messages || []) {
        if (typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content });
            continue;
        }
        const blocks = Array.isArray(m.content) ? m.content : [];
        if (m.role === 'user') {
            // A single Anthropic user message can bundle multiple tool_result blocks
            // (one per prior tool_use) plus text — OpenAI needs each tool_result as
            // its own `role: 'tool'` message, so this can expand to several messages.
            const parts = [];
            for (const block of blocks) {
                if (block.type === 'tool_result') {
                    out.push({ role: 'tool', tool_call_id: sanitizeId(block.tool_use_id), content: toolResultToText(block.content) });
                } else if (block.type === 'text') {
                    parts.push({ type: 'text', text: block.text });
                } else if (block.type === 'image') {
                    const url = imageBlockToDataUrl(block);
                    if (url) parts.push({ type: 'image_url', image_url: { url } });
                }
            }
            if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text });
            else if (parts.length) out.push({ role: 'user', content: parts });
        } else {
            let text = '';
            const toolCalls = [];
            for (const block of blocks) {
                if (block.type === 'text') text += block.text;
                else if (block.type === 'tool_use') {
                    toolCalls.push({ id: sanitizeId(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
                }
                // 'thinking' blocks intentionally dropped — see file header.
            }
            const msg = { role: 'assistant', content: text || null };
            if (toolCalls.length) msg.tool_calls = toolCalls;
            out.push(msg);
        }
    }
    return out;
}

function toOpenAITools(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function toOpenAIToolChoice(choice) {
    if (!choice) return undefined;
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'any') return 'required';
    if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
    return undefined;
}

const STOP_REASON = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

function sseWriter(res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function callXai(openaiBody) {
    if (!config.GROK_API_KEY) {
        const err = new Error('GROK_API_KEY not configured — set it in .env to use Grok models');
        err.code = 'no_api_key';
        throw err;
    }
    const resp = await fetch(`${config.GROK_API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.GROK_API_KEY}` },
        body: JSON.stringify(openaiBody),
    });
    if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        const err = new Error(`xAI API ${resp.status}: ${bodyText.slice(0, 500)}`);
        err.status = resp.status;
        throw err;
    }
    return resp;
}

// Non-streaming fallback — rarely hit, Claude Code always requests stream:true.
function openAIResponseToAnthropic(data) {
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* leave empty on malformed JSON */ }
        content.push({ type: 'tool_use', id: sanitizeId(tc.id), name: tc.function?.name, input });
    }
    return {
        id: randomId('msg'), type: 'message', role: 'assistant', model: data.model, content,
        stop_reason: STOP_REASON[choice.finish_reason] || 'end_turn', stop_sequence: null,
        usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
    };
}

export function mountGrokProxy(app) {
    app.post('/grok/v1/messages', async (req, res) => {
        const auth = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (auth !== config.GROK_PROXY_TOKEN) {
            return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token' } });
        }

        const body = req.body || {};
        const wantsStream = body.stream !== false;
        const openaiBody = {
            model: config.GROK_MODEL,
            messages: toOpenAIMessages(body.system, body.messages),
            max_tokens: body.max_tokens || 4096,
            stream: wantsStream,
        };
        const tools = toOpenAITools(body.tools);
        if (tools) openaiBody.tools = tools;
        const toolChoice = toOpenAIToolChoice(body.tool_choice);
        if (toolChoice) openaiBody.tool_choice = toolChoice;
        if (typeof body.temperature === 'number') openaiBody.temperature = body.temperature;
        if (wantsStream) openaiBody.stream_options = { include_usage: true };

        let upstream;
        try {
            upstream = await callXai(openaiBody);
        } catch (err) {
            console.error(`[GrokProxy] ${err.message}`);
            const status = err.code === 'no_api_key' ? 400 : (err.status || 502);
            return res.status(status).json({ type: 'error', error: { type: 'api_error', message: err.message } });
        }

        if (!wantsStream) {
            try {
                return res.json(openAIResponseToAnthropic(await upstream.json()));
            } catch (err) {
                return res.status(502).json({ type: 'error', error: { type: 'api_error', message: `Bad upstream response: ${err.message}` } });
            }
        }

        // Streaming: translate OpenAI SSE chunks -> Anthropic SSE events incrementally
        // so Claude Code's live token-by-token output keeps working.
        const emit = sseWriter(res);
        emit('message_start', { type: 'message_start', message: { id: randomId('msg'), type: 'message', role: 'assistant', content: [], model: openaiBody.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

        let blockIndex = -1;
        let blockOpen = false;
        let blockKind = null; // 'text' | 'tool'
        const toolByCallIndex = new Map(); // OpenAI tool_calls[].index -> our anthropic block index
        let outputTokens = 0;
        let finalStopReason = 'end_turn';

        const closeBlock = () => { if (blockOpen) { emit('content_block_stop', { type: 'content_block_stop', index: blockIndex }); blockOpen = false; } };
        const openTextBlock = () => { closeBlock(); blockIndex++; blockKind = 'text'; blockOpen = true; emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }); };
        const openToolBlock = (callIndex, id, name) => {
            closeBlock();
            blockIndex++; blockKind = 'tool'; blockOpen = true;
            toolByCallIndex.set(callIndex, blockIndex);
            emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: sanitizeId(id), name: name || 'unknown_tool', input: {} } });
        };

        try {
            const nodeStream = Readable.fromWeb(upstream.body);
            let buf = '';
            for await (const chunk of nodeStream) {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const payload = trimmed.slice(5).trim();
                    if (payload === '[DONE]') continue;
                    let evt;
                    try { evt = JSON.parse(payload); } catch { continue; }
                    if (evt.usage?.completion_tokens != null) outputTokens = evt.usage.completion_tokens;
                    const choice = evt.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta || {};
                    if (typeof delta.content === 'string' && delta.content) {
                        if (blockKind !== 'text' || !blockOpen) openTextBlock();
                        emit('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
                    }
                    if (Array.isArray(delta.tool_calls)) {
                        for (const tc of delta.tool_calls) {
                            const callIndex = tc.index ?? 0;
                            if (!toolByCallIndex.has(callIndex)) openToolBlock(callIndex, tc.id, tc.function?.name);
                            const idx = toolByCallIndex.get(callIndex);
                            const argChunk = tc.function?.arguments;
                            if (argChunk) emit('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: argChunk } });
                        }
                    }
                    if (choice.finish_reason) finalStopReason = STOP_REASON[choice.finish_reason] || 'end_turn';
                }
            }
        } catch (err) {
            console.error(`[GrokProxy] Stream error: ${err.message}`);
        }

        closeBlock();
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: finalStopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        emit('message_stop', { type: 'message_stop' });
        res.end();
    });
}
