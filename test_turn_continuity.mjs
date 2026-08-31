// Guards the promise/deferral detection behind automatic continuation. A turn ends
// when its process exits, so "I'll post the link when it finishes" is a message that
// can never arrive — those replies are continued. Ordinary plans for the next turn
// must NOT be, or every session retries itself at real cost.
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-turn-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PROJECTS_DIR = path.join(tmp, 'docs');

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
const promised = (t) => mgr._promisedMoreWork(t);

// The reply that started this: both halves present.
check('the real case is caught', promised(
    "The enrichment job is running in the background — it'll do a DB pass first, then the web ladder. I'll post the S3 link and a summary here as soon as it finishes."
), true);
check('"will update you once it is done"', promised('Kicked it off. I will update you once it is done.'), true);
check('"notify you when complete"', promised("Started the crawl in the background; I'll notify you when it's complete."), true);
// The phrasings differ every time; the deferral half has to cover the verb forms too.
check('"share the link once it finishes"', promised("Nearly there — I'll share the link once it finishes."), true);
check('"send it after the job completes"', promised('Kicked off the run. I will send it after the job completes.'), true);
check('"post the results when the crawl is done"', promised("I'll post the results when the crawl is done."), true);

// One half alone is an ordinary reply and must be left alone — a false positive here
// spends a whole turn re-running work that is already finished.
check('a plan for the next turn is not a promise', promised("I'll add a test for that next."), false);
check('a finished report is not a promise', promised('Done — the file is at /tmp/out.xlsx.'), false);
check('"when it is done" without a promise', promised('Run the script; it prints the path when it is done.'), false);
check('"in the background" without a promise', promised('The cron job runs in the background every night.'), false);
check('empty reply', promised(''), false);
check('null reply', promised(null), false);

// Thinking is not the reply — a promise quoted inside a tool log must not count.
check('a promise inside a thinking block is ignored', promised(
    "<!--thinking-->\nRunning: echo \"I'll send the link when it finishes\"\n<!--/thinking-->\n\nHere is the file: /tmp/a.xlsx"
), false);
check('text after a thinking block still counts', promised(
    "<!--thinking-->\nRunning: ls\n<!--/thinking-->\n\nIt's running in the background — I'll share the link once it's done."
), true);

// The budget is what stops a model that keeps promising from talking to itself all night.
const s1 = 'WA-test-1';
store.createSession(s1, '+100', 'fill the sheet', 'native-1', '/tmp', 'user-a');
store.addMessage(s1, 'assistant', "It's running in the background — I'll post the link as soon as it finishes.");
store.updateSession(s1, { status: 'completed' });

const spawned = [];
mgr._spawnResume = (sessionId, nativeId, followUp) => spawned.push({ sessionId, followUp });

mgr._continueIfPromised(s1, '/tmp', { costUsd: 1 });
check('a promise is continued', spawned.length, 1);
check('…with the reason spelled out, not a fake user message', /AUTOMATIC CONTINUATION/.test(spawned[0].followUp), true);
check('…and the session is running again', store.getSession(s1).status, 'running');
check('…and the chat says why', store.getMessages(s1, 1)[0].role, 'system');

store.updateSession(s1, { status: 'completed' });
store.addMessage(s1, 'assistant', "Still going in the background — I'll send it when it's done.");
mgr._continueIfPromised(s1, '/tmp', {});
check('a second promise is continued', spawned.length, 2);

store.updateSession(s1, { status: 'completed' });
store.addMessage(s1, 'assistant', "Nearly there — I'll share the link once it finishes.");
mgr._continueIfPromised(s1, '/tmp', {});
check('the third is not — it hands back instead', spawned.length, 2);
check('…and says so in the chat', /Stopping here/.test(store.getMessages(s1, 1)[0].content), true);

// A real user message puts a person back in the loop and restores the budget.
mgr.autoContinues.delete(s1);
store.updateSession(s1, { status: 'completed' });
store.addMessage(s1, 'assistant', "Running in the background; I'll report back when it's finished.");
mgr._continueIfPromised(s1, '/tmp', {});
check('a user turn restores the budget', spawned.length, 3);

// Without a native thread id there is nothing to resume into.
const s2 = 'WA-test-2';
store.createSession(s2, '+100', 'x', null, '/tmp', 'user-a');
store.addMessage(s2, 'assistant', "It's running in the background — I'll post the result when it's done.");
store.updateSession(s2, { status: 'completed' });
mgr._continueIfPromised(s2, '/tmp', {});
check('no native thread id → no continuation', spawned.length, 3);

// A stopped session was stopped on purpose.
const s3 = 'WA-test-3';
store.createSession(s3, '+100', 'x', 'native-3', '/tmp', 'user-a');
store.addMessage(s3, 'assistant', "In the background now — I'll send the link once it finishes.");
store.updateSession(s3, { status: 'stopped' });
mgr._continueIfPromised(s3, '/tmp', {});
check('a stopped session is left stopped', spawned.length, 3);

// The other half of the report: a turn that dies without writing a word used to leave
// the chat completely silent — the user's message, then nothing, forever. Run real
// short-lived processes through the same pty path the agents use.
const runTurn = (sessionId, shell) => new Promise((resolve) => {
    mgr.once('session_end', (e) => setTimeout(() => resolve(e), 50));
    mgr._runPty(sessionId, '/bin/sh', ['-c', shell], tmp);
});

const s4 = 'WA-test-4';
store.createSession(s4, '+100', 'x', 'native-4', tmp, 'user-a');
const killed = await runTurn(s4, 'exit 129');
check('an interrupted turn is marked failed', killed.status, 'failed');
const note4 = store.getMessages(s4, 1)[0];
check('…and the chat says it was interrupted', [note4.role, /interrupted/.test(note4.content), /129/.test(note4.content)], ['system', true, true]);

const s5 = 'WA-test-5';
store.createSession(s5, '+100', 'x', 'native-5', tmp, 'user-a');
await runTurn(s5, 'exit 0');
const note5 = store.getMessages(s5, 1)[0];
check('a clean turn with no reply also says so', [note5.role, /without a reply/.test(note5.content)], ['system', true]);

// A turn that did answer must not get a note bolted onto it.
const s6 = 'WA-test-6';
store.createSession(s6, '+100', 'x', 'native-6', tmp, 'user-a');
const reply = JSON.stringify({ type: 'result', result: 'Here is the answer you asked for.' });
await runTurn(s6, `printf '%s\\n' ${JSON.stringify(reply)}`);
const msgs6 = store.getMessages(s6, 5);
check('a turn that replied gets no note', msgs6.filter(m => m.role === 'system').length, 0);
check('…and the reply is stored', /Here is the answer/.test(msgs6[msgs6.length - 1].content), true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
