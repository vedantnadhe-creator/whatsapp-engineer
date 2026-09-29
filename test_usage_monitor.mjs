// Runnable check for usage_monitor.js transcript parsing: node test_usage_monitor.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
process.env.OLIBOT_CODEX_HOME = path.join(root, 'codex');
const now = new Date().toISOString();
const cId = '11111111-1111-1111-1111-111111111111';
const xId = '22222222-2222-2222-2222-222222222222';
const cDir = path.join(root, 'claude/projects/-home-x');
const xDir = path.join(root, 'codex/sessions/2026/09/29');
fs.mkdirSync(path.join(cDir, cId, 'subagents'), { recursive: true });
fs.mkdirSync(xDir, { recursive: true });

const msg = (id, out) => JSON.stringify({ type: 'assistant', timestamp: now, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: out } } });
// msg a is written twice (two content blocks) — must count once, with the final usage.
fs.writeFileSync(path.join(cDir, `${cId}.jsonl`), [msg('a', 5), msg('a', 7), msg('b', 3), '{"type":"user"}', ''].join('\n'));
fs.writeFileSync(path.join(cDir, cId, 'subagents', 'agent-1.jsonl'), msg('c', 1) + '\n');
const tc = (inp, cached, out) => JSON.stringify({ timestamp: now, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out } } } });
// Cumulative counters, repeated event — must diff, not sum.
fs.writeFileSync(path.join(xDir, `rollout-2026-09-29T00-00-00-${xId}.jsonl`),
    [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }), tc(100, 60, 10), tc(100, 60, 10), tc(250, 200, 30), ''].join('\n'));

const { getUsage } = await import('./usage_monitor.js');
const index = new Map([[cId, { id: 'WA-1', task: 't', ownerId: 'u1', ownerName: 'Asha' }]]);
let u = await getUsage(0, index);
assert.deepStrictEqual(u.totals.claude, { input: 30, cacheWrite: 300, cacheRead: 3000, output: 11, turns: 3 });
assert.deepStrictEqual(u.totals.codex, { input: 50, cacheWrite: 0, cacheRead: 200, output: 30, turns: 2 });
assert.strictEqual(u.users.find((x) => x.userId === 'u1').name, 'Asha');
assert.ok(u.users.find((x) => x.userId === '_unlinked'), 'unmapped codex thread is reported, not dropped');
assert.ok(u.models.some((m) => m.model === 'gpt-5.6-sol'));

// Appending only reads the new bytes; nothing is double-counted.
fs.appendFileSync(path.join(cDir, `${cId}.jsonl`), msg('d', 2) + '\n');
const { refreshIndex } = await import('./usage_monitor.js');
await refreshIndex();
u = await getUsage(0, index);
assert.strictEqual(u.totals.claude.output, 13);
assert.strictEqual(u.totals.claude.turns, 4);
fs.rmSync(root, { recursive: true, force: true });
console.log('usage_monitor: all checks passed');
