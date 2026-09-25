// Task queue: pumping, marker outcomes, Jev hand-off, question tagging, route guards.
// Temp DB + a fake engine — no real sessions are started.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-tq-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { default: SessionStore } = await import('./session_store.js');
const { default: TaskQueue, readMarkers } = await import('./task_queue.js');
const store = new SessionStore();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── markers ──────────────────────────────────────────────────────────────────
assert.equal(readMarkers('all good\n[[TASK_DONE]]').done, true);
assert.equal(readMarkers('I will print [[TASK_DONE]] when finished').done, false, 'DONE must be on its own line');
assert.equal(readMarkers('<!--thinking-->[[TASK_DONE]]\n<!--/thinking-->still going').done, false, 'thinking is ignored');
assert.equal(readMarkers('x\n[[NEEDS_INPUT: Which table, users or accounts?]]').question, 'Which table, users or accounts?');
assert.equal(readMarkers('[[JEV_VERDICT: FAIL]]\n...\n[[JEV_VERDICT: pass]]').verdict, 'PASS', 'last verdict wins');

// ── fake engine ──────────────────────────────────────────────────────────────
let n = 0;
const running = new Set();
const engine = Object.assign(new EventEmitter(), {
    isRunning: (id) => running.has(id),
    resumeSession: async (id) => { running.add(id); },
    forkSession: async (parent, task, phone, owner, model) => {
        const id = `WA-jev${++n}`;
        store.createSession(id, phone, task, null, tmp, owner, model, 'codex');
        running.add(id); engine.lastFork = { parent, task, model };
        return { sessionId: id };
    },
});
const messageHandler = async ({ text, ownerId, model }) => {
    const id = `WA-dev${++n}`;
    store.createSession(id, 'p', text, null, tmp, ownerId, model, 'claude');
    running.add(id);
    return { sessionId: id };
};
const notes = [];
const events = [];
const q = new TaskQueue({
    store, engine, messageHandler,
    broadcast: (t, p) => events.push(t),
    resolveModel: (role, m) => m, testingModel: 'codex:gpt-5.6-sol',
    notify: (u, t) => notes.push({ u, t }),
});
// Turn ends: reply stored, process gone, session_end fired — as ClaudeManager does.
const finishTurn = async (sid, reply, status = 'completed') => {
    store.addMessage(sid, 'assistant', reply);
    running.delete(sid);
    engine.emit('session_end', { sessionId: sid, status });
    await sleep(2800);
};

const u = store.createUser({ email: 'dev@x.io', displayName: 'Dev', role: 'developer', isAdmin: 0 });
const other = store.createUser({ email: 'o@x.io', displayName: 'Other', role: 'developer', isAdmin: 0 });
const mk = (title, who = u.id) => store.createIssue({ title, assignedTo: who });
const A = mk('A'), B = mk('B'), C = mk('C'), D = mk('D'), X = mk('X', other.id);
const item = (issueId) => store.getQueueItems(u.id).find(i => i.issue_id === issueId);
const issue = (id) => store.getIssue(id);
const labels = (id) => JSON.parse(issue(id).labels || '[]');

// Adding never starts anything: the queue is stopped until Run.
for (const [i, jev] of [[A, false], [B, true], [C, false], [D, true]]) store.createQueueItem({ userId: u.id, issueId: i.id, jev, note: i === A ? 'Use the v2 table, not v1.' : null });
await q.pump(u.id);
// A stale legacy flag from before Run existed must not start anything.
store.setSetting(`task_queue:${u.id}`, JSON.stringify({ parallel: 1, paused: false }));
await q.pump(u.id);
assert.equal(item(A.id).status, 'queued', 'a stale paused:false does not start tasks');
assert.equal(item(A.id).status, 'queued', 'nothing starts until Run');

// Run, parallel 1 → one at a time, in order
const run = async () => { store.armQueue(u.id, true); await q.pump(u.id); };
await run();
assert.equal(item(A.id).status, 'running');
assert.match(store.getSession(item(A.id).dev_session_id).task, /Instructions from Dev for this run[\s\S]*Use the v2 table, not v1\./, 'the queue note is in the brief');
assert.equal(item(B.id).status, 'queued', 'parallel=1 leaves the rest queued');
assert.equal(issue(A.id).dev_status, 'in_progress');
assert.match(store.getSession(item(A.id).dev_session_id).task, /\[\[TASK_DONE\]\]/, 'brief carries the marker contract');

// A: done, Jev off → Dev Completed, B starts
await finishTurn(item(A.id).dev_session_id, 'Implemented.\n[[TASK_DONE]]');
assert.equal(item(A.id).status, 'dev_completed');
assert.equal(issue(A.id).dev_status, 'dev_completed');
assert.equal(item(B.id).status, 'running', 'next item takes the freed slot');

// B: question → needs_input, tagged, notified with link; slot moves on to C
await finishTurn(item(B.id).dev_session_id, 'Two options.\n[[NEEDS_INPUT: Soft delete or hard delete?]]');
assert.equal(item(B.id).status, 'needs_input');
assert.equal(item(B.id).question, 'Soft delete or hard delete?');
assert.deepEqual(labels(B.id), ['question']);
assert.match(notes.at(-1).t, /Soft delete or hard delete\?[\s\S]*\/s\/WA-dev/, 'agent gets the question and the session link');
assert.equal(item(C.id).status, 'running', 'a waiting item frees its slot');

// B answered in its session → TASK_DONE, Jev on → Jev fork of the dev session, untagged
const bDev = item(B.id).dev_session_id;
running.add(bDev);
await finishTurn(bDev, 'Did soft delete.\n[[TASK_DONE]]');
assert.equal(item(B.id).status, 'testing');
assert.equal(engine.lastFork.parent, bDev, 'Jev forks the dev session (keeps what changed)');
assert.equal(engine.lastFork.model, 'codex:gpt-5.6-sol', 'Jev runs on the mandated testing model');
assert.match(engine.lastFork.task, /JEV_VERDICT/);
assert.deepEqual(labels(B.id), [], 'question tag removed once it moves on');
assert.equal(issue(B.id).qa_status, 'testing');

// Jev PASS → Done + QA pass
await finishTurn(item(B.id).jev_session_id, '| goal | PASS |\n[[JEV_VERDICT: PASS]]');
assert.equal(item(B.id).status, 'done');
assert.equal(issue(B.id).dev_status, 'done');
assert.equal(issue(B.id).status, 'completed');
assert.equal(issue(B.id).qa_status, 'pass');

// parallel 2 → C still running, D starts too
q.saveSettings(u.id, { parallel: 2 });
await sleep(50);
assert.equal(item(D.id).status, 'running');

// C: ends with no marker → a question, never success
await finishTurn(item(C.id).dev_session_id, 'I looked around.');
assert.equal(item(C.id).status, 'needs_input');
assert.notEqual(issue(C.id).dev_status, 'dev_completed');

// D: done → Jev FAIL → Dev Completed + waiting on the dev (jev phase)
await finishTurn(item(D.id).dev_session_id, 'Done.\n[[TASK_DONE]]');
await finishTurn(item(D.id).jev_session_id, 'bug open\n[[JEV_VERDICT: FAIL]]');
assert.equal(item(D.id).status, 'needs_input');
assert.equal(item(D.id).phase, 'jev');
assert.equal(issue(D.id).dev_status, 'dev_completed');
assert.equal(issue(D.id).qa_status, 'fail');
assert.deepEqual(labels(D.id), ['question']);

// Everything queued has started → the queue stopped itself; a new task waits for Run.
const E = mk('E'); store.createQueueItem({ userId: u.id, issueId: E.id });
await q.pump(u.id);
assert.equal(item(E.id).status, 'queued', 'added after the run → waits for the next Run');

// Auto-continued turn is not judged: session still running after session_end
await run();
const eDev = item(E.id).dev_session_id;
store.addMessage(eDev, 'assistant', 'I will post the result when it finishes');
engine.emit('session_end', { sessionId: eDev, status: 'completed' }); // continuation keeps it running
await sleep(2800);
assert.equal(item(E.id).status, 'running', 'still running → not evaluated');

// Paused → nothing new starts
q.saveSettings(u.id, { parallel: 3 });
const F = mk('F'); store.createQueueItem({ userId: u.id, issueId: F.id });
await q.pump(u.id);
assert.equal(item(F.id).status, 'queued');

// ── routes ───────────────────────────────────────────────────────────────────
const app = express(); app.use(express.json());
let as = u;
q.register(app, (req, res, next) => { req.user = { id: as.id, role: as.role, isAdmin: !!as.isAdmin }; next(); });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };

let r = await call('POST', '/api/my/queue', { issueIds: [X.id, F.id] });
assert.deepEqual(r.j.skipped.map(s => s.reason).sort(), ['already queued', 'not assigned to you']);
assert.equal((await call('PUT', '/api/my/queue/settings', { parallel: 4 })).s, 400, 'parallel capped at 3');
assert.equal((await call('DELETE', `/api/my/queue/${item(E.id).id}`)).s, 409, 'cannot remove a running task');
r = await call('GET', '/api/my/work');
assert.equal(r.j.questions, 2);
assert.ok(r.j.counts.total >= 5);
// Notes: set on add, editable only while queued, validated; adding does not start the task.
const G = mk('G');
r = await call('POST', '/api/my/queue', { issueIds: [G.id], notes: { [G.id]: '  Only the mobile layout.  ' } });
assert.equal(item(G.id).note, 'Only the mobile layout.');
assert.equal(item(G.id).status, 'queued', 'POST never starts the task');
assert.equal((await call('POST', '/api/my/queue', { issueIds: [mk('H').id], notes: { x: 'a'.repeat(4001) } })).s, 400, 'note length capped');
assert.equal((await call('PUT', `/api/my/queue/${item(G.id).id}`, { note: 'Mobile and tablet.' })).s, 200);
assert.equal(item(G.id).note, 'Mobile and tablet.');
assert.equal((await call('PUT', `/api/my/queue/${item(E.id).id}`, { note: 'late' })).s, 409, 'no editing once it has started');

// Stop disarms; Run arms what is queued now and starts it.
r = await call('POST', '/api/my/queue/stop');
assert.equal(r.j.run.armed, 0);
assert.equal(r.j.run.waiting, 2, 'F and G wait for Run');
r = await call('POST', '/api/my/queue/run');
assert.equal(r.j.armed, 2);
assert.equal(item(G.id).status, 'running', 'Run starts what was queued');

// Team view: admins only, read-only, labelled by person.
store.createQueueItem({ userId: other.id, issueId: X.id });
assert.equal((await call('GET', `/api/my/queue?users=${other.id}`)).s, 403, 'non-admins cannot see other queues');
assert.equal((await call('GET', `/api/my/work?users=${other.id}`)).s, 403, 'non-admins cannot see other people\'s tasks');
as = { ...u, isAdmin: true };
r = await call('GET', `/api/my/queue?users=${u.id},${other.id},nobody`);
assert.ok(r.j.team.some(i => i.user_id === other.id && i.user_name === 'Other'), 'admin sees the other person\'s queue');
assert.ok(!r.j.team.some(i => i.user_id === u.id), 'your own queue is not repeated in the team list');
r = await call('GET', `/api/my/work?users=${other.id}`);
assert.ok(r.j.team_issues.some(i => i.id === X.id && i.user_name === 'Other'), 'admin sees the other person\'s assigned tasks');
assert.ok(r.j.issues.every(i => !i.user_id), 'my own list stays mine');
as = u;

as = other;
assert.equal((await call('PUT', `/api/my/queue/${item(F.id).id}`, { jev: true })).s, 404, 'someone else\'s item is invisible');
as = u;
assert.equal((await call('DELETE', `/api/my/queue/${item(C.id).id}`)).s, 200);
assert.deepEqual(labels(C.id), [], 'removing a waiting item clears its question tag');
srv.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Task queue tests passed');
process.exit(0);
