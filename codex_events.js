// Codex JSONL → Claude stream-json event translation.
//
// `codex exec --json` emits its own event vocabulary:
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.started"|"item.updated"|"item.completed","item":{...}}
//   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,...}}
//   {"type":"turn.failed","error":{...}} / {"type":"error","message":"..."}
//
// Rather than teach the dashboard a second event language, we translate here into
// the Claude shapes `_handleEvent` already consumes ('assistant' / 'result' /
// 'error'). Everything downstream — message upserts, thinking blocks, cost, the
// websocket fan-out, session status — then works unchanged.
//
// ponytail: covers the item types Codex emits today (agent_message, reasoning,
// command_execution, file_change, mcp_tool_call, web_search, todo_list, error).
// An unrecognised item type is surfaced as a thinking line rather than dropped,
// so a Codex upgrade degrades to "less pretty" instead of "silently missing".

// One Codex item → a Claude content block, or null to ignore it.
function itemToBlock(item) {
    if (!item || typeof item !== 'object') return null;
    const t = item.type;

    // The actual reply text.
    if (t === 'agent_message') {
        const text = item.text ?? item.message ?? '';
        return text ? { type: 'text', text } : null;
    }

    // Everything else is progress detail. _extractThinking() renders tool_use
    // blocks into the collapsible thinking section, so borrow that shape.
    if (t === 'reasoning') {
        const text = item.text ?? item.summary ?? '';
        return text ? { type: 'tool_use', name: 'Thinking', input: { thought: text } } : null;
    }
    if (t === 'command_execution') {
        return { type: 'tool_use', name: 'Bash', input: { command: item.command ?? '', exit_code: item.exit_code } };
    }
    if (t === 'file_change') {
        const files = Array.isArray(item.changes)
            ? item.changes.map(c => c.path ?? c.file ?? '').filter(Boolean)
            : [item.path ?? ''].filter(Boolean);
        return { type: 'tool_use', name: 'Edit', input: { files } };
    }
    if (t === 'mcp_tool_call') {
        return { type: 'tool_use', name: `MCP:${item.server ?? '?'}/${item.tool ?? '?'}`, input: item.arguments ?? {} };
    }
    if (t === 'web_search') {
        return { type: 'tool_use', name: 'WebSearch', input: { query: item.query ?? '' } };
    }
    if (t === 'todo_list') {
        return { type: 'tool_use', name: 'TodoWrite', input: { items: item.items ?? [] } };
    }
    if (t === 'error') {
        return { type: 'tool_use', name: 'Error', input: { message: item.message ?? '' } };
    }
    return { type: 'tool_use', name: t || 'unknown', input: {} };
}

// Codex reports token counts but no dollar cost — under a ChatGPT plan the spend is
// subscription credits, not per-token billing, so there is no honest USD figure to
// report. Emitting 0 keeps CostView's token columns accurate without inventing money.
function toUsage(usage) {
    if (!usage) return undefined;
    return {
        input_tokens: (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
        output_tokens: usage.output_tokens ?? 0,
    };
}

// Translate one Codex event into zero or more Claude-shaped events.
// `ctx` carries the thread id across the turn so the closing 'result' can report it.
export function translateCodexEvent(evt, ctx = {}) {
    if (!evt || typeof evt !== 'object') return [];

    switch (evt.type) {
        case 'thread.started':
            // Codex's thread id is this session's resume handle — the direct
            // analogue of claude_session_id.
            ctx.threadId = evt.thread_id || ctx.threadId;
            return [];

        case 'turn.started':
            return [];

        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
            // Only completed items are rendered; started/updated would re-emit the
            // same text repeatedly and duplicate it in the transcript.
            if (evt.type !== 'item.completed') return [];
            const block = itemToBlock(evt.item);
            return block ? [{ type: 'assistant', message: { content: [block] } }] : [];
        }

        case 'turn.completed':
            return [{
                type: 'result',
                session_id: ctx.threadId || null,
                usage: toUsage(evt.usage),
                total_cost_usd: 0,
            }];

        case 'turn.failed':
            return [{ type: 'error', message: evt.error?.message || 'Codex turn failed' }];

        case 'error':
            return [{ type: 'error', message: evt.message || 'Codex error' }];

        default:
            return [];
    }
}
