// Guards the transcript fallback for turns whose reply never reached the pty stream,
// including a `result` event with empty text (WA-mumkb8b1-57v5, 2026-09-29).
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-salvage-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PROJECTS_DIR = path.join(tmp, 'docs');
process.env.HOME = tmp; // os.homedir() → the fake ~/.claude below

const { default: SessionStore } = await import('./session_store.js');
const { default: ClaudeManager } = await import('./claude_manager.js');

let failed = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const store = new SessionStore();
const mgr = new ClaudeManager(store);
const cwd = '/work/dir';
const dir = path.join(tmp, '.claude', 'projects', cwd.replace(/\//g, '-'));
fs.mkdirSync(dir, { recursive: true });

const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const toolResult = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const said = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const thought = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } });

function run(lines) {
    const id = `WA-${Math.random().toString(36).slice(2)}`;
    const claudeId = `c-${id}`;
    store.createSession(id, 'web', 'task', cwd);
    store.updateSession(id, { claude_session_id: claudeId });
    fs.writeFileSync(path.join(dir, `${claudeId}.jsonl`), lines.join('\n') + '\n');
    const entry = { claudeSessionId: claudeId, resultEmitted: true };
    mgr._salvageFromTranscript(id, entry, cwd);
    return entry.repliedText ? store.getMessages(id).at(-1)?.content : null;
}

check('reply after tool use is recovered', run([user('old q'), said('old answer'), user('how much?'), thought, toolResult, thought, said('About $0.25.')]), 'About $0.25.');
check("a turn with no text never re-posts the previous turn's answer", run([user('old q'), said('old answer'), user('new q'), thought, toolResult]), null);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
