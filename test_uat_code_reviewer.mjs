import assert from 'node:assert/strict';
import { CODE_REVIEWER_MODEL, UatCodeReviewer, buildUatReviewTask, hasSuccessfulUatDeploy } from './uat_code_reviewer.js';

const sessions = new Map([
    ['WA-dev', { id: 'WA-dev', owner_id: 'user-1', user_phone: 'dev@example.com', name: 'Fix assessment invite', sprint_id: 'sprint-42', mode: 'developer' }],
]);
const messages = [];
const broadcasts = [];
const forks = [];
const store = {
    getSession: id => sessions.get(id),
    updateSession: (id, updates) => sessions.set(id, { ...sessions.get(id), ...updates }),
    addMessage: (sessionId, role, content) => messages.push({ sessionId, role, content }),
};
const engine = {
    forkSession: async (...args) => {
        forks.push(args);
        const id = `WA-review-${forks.length}`;
        sessions.set(id, { id });
        return { sessionId: id };
    },
    isRunning: () => false,
};
const reviewer = new UatCodeReviewer({ store, engine, broadcast: (type, payload) => broadcasts.push({ type, payload }) });

assert.equal(hasSuccessfulUatDeploy('done'), false);
assert.equal(hasSuccessfulUatDeploy('done\n[[UAT_DEPLOYED]]'), true);
assert.match(buildUatReviewTask('WA-dev'), /READ-ONLY/);

assert.equal(await reviewer.start('WA-dev', '[[DEV_DEPLOYED]]'), null, 'DEV deploys are not reviewed');
assert.equal(await reviewer.start('WA-dev', 'Shipped\n[[UAT_DEPLOYED]]'), 'WA-review-1');
assert.equal(forks.length, 1);
assert.equal(forks[0][0], 'WA-dev', 'review inherits the deploying session context');
assert.equal(forks[0][4], CODE_REVIEWER_MODEL);
assert.deepEqual(forks[0][5], { mode: 'code_reviewer', editAccess: false });
assert.equal(sessions.get('WA-review-1').parent_session_id, 'WA-dev');
assert.equal(sessions.get('WA-review-1').edit_access, 0);
assert.match(messages.at(-1).content, /Rivet.*started.*Open review/);

await reviewer.start('WA-dev', 'Shipped\n[[UAT_DEPLOYED]]');
assert.equal(forks.length, 1, 'duplicate result events do not create duplicate reviewers');
await reviewer.start('WA-dev', 'Shipped another change\n[[UAT_DEPLOYED]]');
assert.equal(forks.length, 2, 'a later UAT deploy in the same session gets a new review');

reviewer.finished('WA-review-1', 'completed');
assert.match(messages.at(-1).content, /Rivet.*finished.*Open review/);
assert.equal(broadcasts.at(-1).payload.sessionId, 'WA-dev');

console.log('UAT code reviewer tests passed');
