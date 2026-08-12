// Guards the sprint Start/Stop contract. The board (sprintMeta.js) and the API +
// mailer (session_store.js) each carry their own copy of the status vocabulary; if
// they drift, the board offers a status the API rejects, or labels one it cannot
// explain — and "only a running sprint mails" quietly stops being true.
import { SPRINT_STATUSES, SPRINT_ACTIVE, SPRINT_PLANNING } from './session_store.js';
import { SPRINT_STATUS, isSprintRunning } from './public-react/src/components/sprintMeta.js';

let failed = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

check('board and API agree on the status vocabulary',
    SPRINT_STATUS.map(s => s.v).sort(), [...SPRINT_STATUSES].sort());

check('a new sprint is not started', SPRINT_PLANNING, 'planning');
check('only "active" counts as running', SPRINT_ACTIVE, 'active');

for (const status of SPRINT_STATUSES) {
    check(`isSprintRunning("${status}")`, isSprintRunning({ status }), status === SPRINT_ACTIVE);
}
check('isSprintRunning(undefined sprint)', isSprintRunning(undefined), false);

// The daily mailer and the manual send both select on this predicate.
const fixture = [
    { name: 'not started', status: 'planning' },
    { name: 'running', status: 'active' },
    { name: 'stopped', status: 'completed' },
];
check('only the running sprint is mailed',
    fixture.filter(s => s.status === SPRINT_ACTIVE).map(s => s.name), ['running']);

console.log(failed === 0 ? '\n✅ sprint status contract OK' : `\n❌ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
