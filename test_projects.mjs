// Guards the Projects contract: a project is shared (not per-user like a playlist),
// its slug is a safe unique filename, forks inherit membership, and the context doc
// keeps a complete session log. Runs against a throwaway DB + docs dir.
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olibot-projects-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PROJECTS_DIR = path.join(tmp, 'docs');

const { default: SessionStore } = await import('./session_store.js');
const { slugify, writeProjectDoc, syncProjectSessions, appendProjectUpdate, readProjectDoc, projectContextBanner } = await import('./project_doc.js');
const { logSessionEvent, logIssueEvent, extractMarkerUpdates, logMarkersFromOutput } = await import('./project_events.js');

let failed = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const store = new SessionStore();

// A slug names a file on disk, so it must never carry a path.
check('slugify strips path traversal', slugify('../../etc/passwd'), 'etc_passwd');
check('slugify falls back for empty names', slugify('///'), 'project');
check('slugify keeps it readable', slugify('Search service ES → Postgres'), 'search_service_es_postgres');

store.createSession('S-root', '+100', 'Migrate search to Postgres', null, '/home/ubuntu/search', 'user-a');
store.createSession('S-fork', '+100', 'Backfill the index', null, '/home/ubuntu/search', 'user-a');
store.createSession('S-other', '+200', 'Unrelated work', null, '/home/ubuntu', 'user-b');

const project = store.createProject({ name: 'Search → Postgres', slug: slugify('Search → Postgres'), description: 'ES out, PG in.', rootSessionId: 'S-root', createdBy: 'user-a' });
store.addToProject(project.id, 'S-root', 'user-a');

// Names collide in real life; the doc filename must not.
const twin = store.createProject({ name: 'Search → Postgres', slug: slugify('Search → Postgres'), createdBy: 'user-b' });
check('a clashing name gets its own slug', twin.slug !== project.slug, true);

check('project lists its sessions', store.getProject(project.id).session_ids, ['S-root']);
check('every project is visible to everyone', store.getProjects().length, 2);

// Shared, unlike playlists: user-b sees user-a's project sessions, marked not-mine.
const asOther = store.getProjectSessions('user-b', project.id);
check('another user sees the project sessions', asOther.map(s => s.id), ['S-root']);
check('…but they are not marked as theirs', asOther[0].is_mine, 0);
check('count matches', store.countProjectSessions(project.id), 1);
check('search inside a project', store.searchProjectSessions('user-a', project.id, 'Migrate').map(s => s.id), ['S-root']);
check('search count matches', store.countSearchProjectSessions(project.id, 'Migrate'), 1);
check('a session outside the project stays out', store.getProjectSessions('user-a', project.id).some(s => s.id === 'S-other'), false);

// A fork continues the work, so it joins the parent's projects.
const inherited = store.inheritProjects('S-root', 'S-fork', 'user-a');
check('fork inherits the project', inherited.map(p => p.id), [project.id]);
check('fork is now in the project', store.getProject(project.id).session_ids.sort(), ['S-fork', 'S-root']);
check('sessions know their projects', store.getSessionProjects('S-fork').map(p => p.id), [project.id]);
check('the banner points the fork at the doc', projectContextBanner(inherited).includes(inherited[0].slug), true);

// The doc is the project's reference point — roster from the DB, events appended.
const docPath = writeProjectDoc(store.getProject(project.id), { rootSession: store.getSession('S-root'), creatorName: 'Alex' });
store.updateProject(project.id, { docPath });
const readDoc = () => readProjectDoc(store.getProject(project.id)).content;
check('doc lives under PROJECTS_DIR', docPath.startsWith(process.env.PROJECTS_DIR), true);
check('doc logs the root session', readDoc().includes('S-root'), true);
check('doc carries the description', readDoc().includes('ES out, PG in.'), true);
check('doc explains the marker to the agent', projectContextBanner([store.getProject(project.id)]).includes('[[PROJECT:'), true);

// The roster is regenerated from the DB, so it can never drift.
logSessionEvent(store, 'S-fork', 'Forked `S-fork` from `S-root` — Backfill the index', { roster: true });
check('roster picks up the fork', readDoc().includes('S-fork'), true);
check('roster shows session status', readDoc().includes('_(running)_'), true);
check('the fork event is logged', readDoc().includes('Forked `S-fork`'), true);
check('roster stays above the log', readDoc().indexOf('## Sessions') < readDoc().indexOf('## Updates'), true);

// Repeated syncs must not duplicate the roster or eat the log.
syncProjectSessions(store.getProject(project.id), [store.getSession('S-root'), store.getSession('S-fork')]);
check('re-syncing does not duplicate a session', readDoc().split('`S-fork`').length - 1 >= 1, true);
check('re-syncing keeps one Sessions heading', readDoc().split('## Sessions').length - 1, 1);
check('re-syncing keeps the log', readDoc().includes('Forked `S-fork`'), true);

// The same marker arrives on both assistant_message and result — log it once.
check('marker vocabulary: UAT', extractMarkerUpdates('shipped [[UAT_DEPLOYED]]'), ['🚀 Deployed to UAT']);
check('marker vocabulary: free note', extractMarkerUpdates('[[PROJECT: deployed to DEV]]'), ['deployed to DEV']);
check('marker vocabulary: none', extractMarkerUpdates('just chatting'), []);
logMarkersFromOutput(store, 'S-root', 'done [[PROJECT: deployed to DEV]]');
logMarkersFromOutput(store, 'S-root', 'done [[PROJECT: deployed to DEV]]');
check('a repeated marker is logged once', readDoc().split('deployed to DEV').length - 1, 1);

// Sprint / QA events reach the project through the issue's sessions.
const issue = store.createIssue({ title: 'Search cutover', createdBy: 'user-a', sessionId: 'S-root' });
check('an issue event lands in the project', logIssueEvent(store, store.getIssue(issue.id), '📋 "Search cutover" → Dev Completed'), 1);
check('…and is written to the doc', readDoc().includes('Dev Completed'), true);
check('an issue with no project session logs nowhere', logIssueEvent(store, { id: 'X', session_id: 'S-other' }, 'ignored'), 0);

// A deleted doc is rebuilt rather than silently skipped.
fs.unlinkSync(docPath);
appendProjectUpdate(store.getProject(project.id), 'after the doc went missing');
check('a missing doc is recreated on the next append', readDoc().includes('after the doc went missing'), true);

// Deleting a session must not leave it filed in a project.
store.deleteSession('S-fork');
check('deleted sessions leave the project', store.getProject(project.id).session_ids, ['S-root']);
store.deleteSession('S-root');
check('deleting the root session clears the pointer', store.getProject(project.id).root_session_id, null);

// Deleting a project drops the grouping only.
store.deleteProject(project.id);
check('project is gone', store.getProject(project.id), null);
check('its sessions are not', !!store.getSession('S-other'), true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll project checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
