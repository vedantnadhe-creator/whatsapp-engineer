// A session whose Claude Code transcript was cleaned up (30-day retention) must recover
// from the dashboard's stored messages instead of `--resume`-ing into "No conversation found".
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-expired-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { default: SessionStore } = await import('./session_store.js');
const { default: ClaudeManager } = await import('./claude_manager.js');
const store = new SessionStore();
const cm = new ClaudeManager(store);
const calls = [];
cm._spawnNew = (id, prompt) => calls.push({ kind: 'new', id, prompt });
cm._spawnResume = (id, claudeId) => calls.push({ kind: 'resume', id, claudeId });

// Transcript present → an ordinary resume.
const dir = path.join(tmp, 'work');
const live = '11111111-1111-1111-1111-111111111111';
const projDir = path.join(os.homedir(), '.claude', 'projects', dir.replace(/\//g, '-'));
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, `${live}.jsonl`), '{}\n');
store.createSession('WA-live', 'p', 'task', null, dir, null, 'claude-opus-5-5', 'claude');
store.updateSession('WA-live', { claude_session_id: live, status: 'completed' });
await cm.resumeSession('WA-live', 'go on');
assert.deepEqual(calls.at(-1), { kind: 'resume', id: 'WA-live', claudeId: live });

// Transcript gone → fresh conversation carrying the stored history + the new message.
store.createSession('WA-old', 'p', 'Build the thing', null, dir, null, 'claude-opus-5-5', 'claude');
store.addMessage('WA-old', 'assistant', 'Earlier progress: step 1 done');
store.updateSession('WA-old', { claude_session_id: '22222222-2222-2222-2222-222222222222', status: 'failed' });
const r = await cm.resumeSession('WA-old', 'continue please');
assert.equal(r.recovered, true);
assert.equal(calls.at(-1).kind, 'new', 'no --resume of a missing transcript');
assert.match(calls.at(-1).prompt, /Earlier progress: step 1 done/, 'stored history is carried over');
assert.match(calls.at(-1).prompt, /continue please/);
assert.equal(store.getSession('WA-old').claude_session_id, null, 'dead id dropped; the new run gets a fresh one');

fs.rmSync(path.join(projDir, `${live}.jsonl`)); fs.rmdirSync(projDir);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Expired transcript resume tests passed');
process.exit(0);
