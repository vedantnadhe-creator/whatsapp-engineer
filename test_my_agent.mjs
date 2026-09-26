// The personal agent keeps ONE session per person: rules changes land in its CLAUDE.md
// (re-read every turn), never as a new session that throws away the conversation.
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-agent-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.MY_AGENT_DIR = path.join(tmp, 'agents');
const { default: SessionStore } = await import('./session_store.js');
const { default: MyAgent } = await import('./my_agent.js');
const store = new SessionStore();
let started = 0;
const engine = {
    startSession: async (key, task, dir, img, owner, model) => {
        const id = `WA-agent${++started}`;
        store.createSession(id, key, task, null, dir, owner, model, 'claude');
        return { sessionId: id };
    },
};
const agent = new MyAgent({ store, engine, broadcast: () => {}, port: 1 });
const u = store.createUser({ email: 'a@x.io', displayName: 'A', role: 'developer', isAdmin: 1 });

const first = await agent.ensure(u);
assert.equal(first.created, true);
const rules = path.join(process.env.MY_AGENT_DIR, u.id, 'CLAUDE.md');
assert.match(fs.readFileSync(rules, 'utf8'), /POST \/api\/sessions\/:id\/message/, 'rules live in CLAUDE.md, incl. writing into sessions');

// A rules change must not start a new session.
agent._primer = () => 'NEW RULES v2';
const again = await agent.ensure(u);
assert.deepEqual(again, { sessionId: first.sessionId, created: false }, 'same session after a rules change');
assert.equal(fs.readFileSync(rules, 'utf8'), 'NEW RULES v2', 'the change reaches the existing session via CLAUDE.md');
assert.equal(started, 1);

// Token is never admin, and is private.
const tok = path.join(process.env.MY_AGENT_DIR, u.id, '.token');
assert.equal(fs.statSync(tok).mode & 0o777, 0o600);
assert.equal(JSON.parse(Buffer.from(fs.readFileSync(tok, 'utf8').split('.')[1], 'base64url')).isAdmin, false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('My agent tests passed');
process.exit(0);
