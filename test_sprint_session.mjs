// Runnable check for the single-session sprint agent:
//   node test_sprint_session.mjs
// Fakes the store and ClaudeManager so it asserts the routing contract only: ONE
// session for all groups, replies to whichever group asked, turns serialized.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-session-'));
process.env.SPRINT_AGENT_DIR = path.join(tmp, 'workspace');
process.env.JWT_SECRET = 'test-secret';
process.chdir(tmp); // the token file is written to cwd — keep the real one untouched

const { default: SprintSession } = await import('/home/ubuntu/whatsapp-engineer/sprint_session.js');

const settings = new Map();
const sessions = new Map();
const users = new Map();
const store = {
    getSetting: k => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    getSession: id => sessions.get(id) || null,
    getUserByEmail: email => users.get(email) || null,
    createUser: ({ email, displayName, role }) => {
        const user = { id: `u-${users.size + 1}`, email, display_name: displayName, role };
        users.set(email, user);
        return user;
    },
};

class FakeClaude extends EventEmitter {
    constructor() { super(); this.started = []; this.resumed = []; this.running = new Set(); }
    isRunning(id) { return this.running.has(id); }
    async startSession(userPhone, prompt, workingDir, _img, ownerId, model) {
        const sessionId = `WA-sprint-${this.started.length + 1}`;
        this.started.push({ sessionId, userPhone, prompt, workingDir, ownerId, model });
        sessions.set(sessionId, { id: sessionId, claude_session_id: `claude-${sessionId}`, user_phone: userPhone });
        this.running.add(sessionId);
        return { sessionId };
    }
    async resumeSession(sessionId, followUp) {
        if (this.running.has(sessionId)) throw new Error(`Session ${sessionId} is currently running.`);
        this.resumed.push({ sessionId, followUp });
        this.running.add(sessionId);
        return { sessionId };
    }
    /** What _runPty does when a turn finishes. */
    finish(sessionId, content) {
        this.running.delete(sessionId);
        this.emit('result', { sessionId, content });
        this.emit('session_end', { sessionId, status: 'completed' });
    }
}

const claude = new FakeClaude();
const sent = [];
const muted = new Set();
const agent = new SprintSession({
    store,
    claude,
    send: async (destination, text) => { sent.push({ destination, text }); },
    mute: id => muted.add(id),
    port: 18790,
});

const GROUP_A = '120363000000000001@g.us';
const GROUP_B = '120363000000000002@g.us';
const tag = (groupJid, text, pushName = 'Tester') =>
    agent.handle({ text, phone: '919960000001', pushName, groupJid });

// 1. First tag starts exactly one session, primed, in the sandbox workspace.
const first = tag(GROUP_A, 'add bug Login broken to Sprint 37');
await new Promise(r => setImmediate(r));
assert.strictEqual(claude.started.length, 1, 'first tag should start one session');
const id = claude.started[0].sessionId;
assert.strictEqual(claude.started[0].userPhone, 'sprint-agent');
assert.strictEqual(claude.started[0].workingDir, process.env.SPRINT_AGENT_DIR);
assert.ok(claude.started[0].prompt.includes('sprint board agent'), 'first turn must carry the primer');
assert.ok(claude.started[0].prompt.includes('add bug Login broken to Sprint 37'), 'first turn must carry the request');
assert.ok(claude.started[0].ownerId, 'board edits must be attributed to the bot user');
assert.ok(muted.has(id), 'the shared session must not use the default WhatsApp broadcast');

// The stored message carries a thinking block of curl narration — the group must
// only see the answer, never the token path or the token itself.
claude.finish(id, `<!--thinking-->\nRunning: T=$(cat ${path.join(tmp, '.sprint-api-token')}); curl -s -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.signature"\n<!--/thinking-->\n\n✅ Added *Login broken* to *Sprint 37*.`);
await first;
assert.deepStrictEqual(sent, [{ destination: GROUP_A, text: '✅ Added *Login broken* to *Sprint 37*.' }]);

// 2. A tag from a DIFFERENT group resumes the SAME session and answers that group.
const second = tag(GROUP_B, 'sprint status');
await new Promise(r => setImmediate(r));
assert.strictEqual(claude.started.length, 1, 'a second group must not start a second session');
assert.deepStrictEqual(claude.resumed.map(r => r.sessionId), [id]);
assert.ok(claude.resumed[0].followUp.includes(GROUP_B), 'the turn should say which group asked');
claude.finish(id, 'Sprint 37 — 16 tasks.');
await second;
assert.deepStrictEqual(sent.at(-1), { destination: GROUP_B, text: 'Sprint 37 — 16 tasks.' });

// 3. Two tags at once queue instead of colliding with "session is currently running".
const third = tag(GROUP_A, 'mark Login broken done');
const fourth = tag(GROUP_B, 'assign Login broken to Ravi');
await new Promise(r => setImmediate(r));
assert.strictEqual(claude.resumed.length, 2, 'the queued tag must wait for the live turn');
claude.finish(id, '✅ Marked *Login broken* done.');
await third;
await new Promise(r => setImmediate(r));
assert.strictEqual(claude.resumed.length, 3, 'the queued tag must run once the turn ends');
claude.finish(id, '✅ Assigned *Login broken* to *Ravi*.');
await fourth;
assert.deepStrictEqual(sent.slice(-2).map(s => s.destination), [GROUP_A, GROUP_B]);

// 4. A failed turn still tells the group, and only once.
const fifth = tag(GROUP_A, 'add task Something');
await new Promise(r => setImmediate(r));
claude.running.delete(id);
claude.emit('session_end', { sessionId: id, status: 'failed' });
await fifth;
assert.match(sent.at(-1).text, /failed/i, 'a failed turn must be reported to the group');
assert.strictEqual(sent.at(-1).destination, GROUP_A);

// 5. The session id is persisted, so a dashboard restart keeps the same thread.
assert.strictEqual(store.getSetting('sprint_agent_session_id'), id);

// 6. The API token is on disk, owner-only.
const tokenPath = path.join(tmp, '.sprint-api-token');
assert.ok(fs.existsSync(tokenPath), 'API token file should be written');
assert.strictEqual(fs.statSync(tokenPath).mode & 0o777, 0o600, 'token must be owner-only');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK — 6 sprint-session routing checks passed');
