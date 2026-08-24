// Guards multi-dev features: `assignees` is the whole team, `assigned_to` stays the
// primary so every legacy join keeps working, "my work" sees a second dev, and a
// sheet round-trip carries the whole team instead of dropping all but the first.
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-assign-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PROJECTS_DIR = path.join(tmp, 'docs');

const { default: SessionStore, parseAssignees } = await import('./session_store.js');
const { buildSprintGrids, importSprintData } = await import('./sprint_sheet.js');
const { TABS, recordsFromGrid } = await import('./sheet_schema.js');

// The upload path is workbook → records → importSprintData; go through the same
// record step here so the test exercises the real column mapping.
const asFeatures = (grid) => ({ features: recordsFromGrid(TABS.FEATURES, grid) });

let failed = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const store = new SessionStore();
const ravi = store.createUser({ email: 'ravi@x.com', displayName: 'Ravi', role: 'developer' });
const prabha = store.createUser({ email: 'prabha@x.com', displayName: 'Prabha', role: 'developer' });
const mari = store.createUser({ email: 'mari@x.com', displayName: 'Mari', role: 'developer' });
const sprint = store.createSprint({ name: 'Sprint 39', createdBy: ravi.id });

const feature = store.createIssue({ title: 'Search cutover', createdBy: ravi.id, sprintId: sprint.id, type: 'feature' });

// One dev assigned the old way must still read back as a one-person team.
store.updateIssue(feature.id, { assigned_to: ravi.id });
check('single assign fills the team', parseAssignees(store.getIssue(feature.id)), [ravi.id]);

// The team is what the board writes; assigned_to must follow it, or every existing
// join (mailer, exports, bug fork) silently points at the wrong person.
store.updateIssue(feature.id, { assignees: [ravi.id, prabha.id, mari.id] });
const multi = store.getIssue(feature.id);
check('the whole team is stored', parseAssignees(multi), [ravi.id, prabha.id, mari.id]);
check('assigned_to tracks the primary', multi.assigned_to, ravi.id);

store.updateIssue(feature.id, { assignees: [prabha.id, prabha.id, '', null, ravi.id] });
check('duplicates and blanks are dropped', parseAssignees(store.getIssue(feature.id)), [prabha.id, ravi.id]);
check('reordering moves the primary', store.getIssue(feature.id).assigned_to, prabha.id);

// A single-assign screen replaces the team rather than leaving a stale one behind.
store.updateIssue(feature.id, { assigned_to: mari.id });
check('single assign replaces the team', parseAssignees(store.getIssue(feature.id)), [mari.id]);

store.updateIssue(feature.id, { assignees: [] });
const cleared = store.getIssue(feature.id);
check('clearing the team clears the primary', [parseAssignees(cleared), cleared.assigned_to], [[], null]);

// "My work" has to see someone who is not the primary, or a second dev is told
// they have nothing assigned.
store.updateIssue(feature.id, { assignees: [ravi.id, prabha.id], dev_status: 'in_progress' });
check('the primary sees it', store.getIssuesAssignedTo(ravi.id).map(i => i.id), [feature.id]);
check('a second dev sees it too', store.getIssuesAssignedTo(prabha.id).map(i => i.id), [feature.id]);
check('an unrelated dev does not', store.getIssuesAssignedTo(mari.id).map(i => i.id), []);

// The mailer prints one Dev column; it must name everyone.
const row = store.getIssuesBySprint(sprint.id).find(i => i.id === feature.id);
check('the sprint row carries every name', row.assignee_names, 'Ravi, Prabha');

// The sheet round-trip is where a multi-dev cell is easiest to destroy: export the
// list, re-import it unchanged, and the team must survive.
const featureGrid = buildSprintGrids(store, sprint.id)[TABS.FEATURES];
const devCol = featureGrid[0].indexOf('Dev');
check('export writes the whole team', featureGrid[1][devCol], 'Ravi, Prabha');

check('re-import is a no-op on the team', (() => {
    importSprintData(store, sprint.id, asFeatures(featureGrid), ravi.id);
    return parseAssignees(store.getIssue(feature.id));
})(), [ravi.id, prabha.id]);

// A hand-typed cell in either order, by name or email, still resolves.
const typed = featureGrid.map(r => [...r]);
typed[1][devCol] = 'prabha@x.com, Ravi';
const typedSummary = importSprintData(store, sprint.id, asFeatures(typed), ravi.id);
check('the row really was updated', typedSummary.features.updated, 1);
check('names and emails both resolve', parseAssignees(store.getIssue(feature.id)), [prabha.id, ravi.id]);

// One dev typed alone must shrink the team, not leave the other silently attached.
const single = featureGrid.map(r => [...r]);
single[1][devCol] = 'Mari';
importSprintData(store, sprint.id, asFeatures(single), ravi.id);
check('a one-name cell replaces the team', parseAssignees(store.getIssue(feature.id)), [mari.id]);

// An unresolvable name must not silently wipe the team either — warn instead.
const bogus = featureGrid.map(r => [...r]);
bogus[1][devCol] = 'Someone Not On The Roster';
const bogusSummary = importSprintData(store, sprint.id, asFeatures(bogus), ravi.id);
check('an unknown name is reported', bogusSummary.warnings.length, 1);
check('…and the team is left alone', parseAssignees(store.getIssue(feature.id)), [mari.id]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
