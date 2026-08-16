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
const { slugify, writeProjectDoc, appendProjectSession, readProjectDoc, projectContextBanner } = await import('./project_doc.js');

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

// The doc is the project's reference point — it must log every session.
const docPath = writeProjectDoc(store.getProject(project.id), { rootSession: store.getSession('S-root'), creatorName: 'Alex' });
store.updateProject(project.id, { docPath });
appendProjectSession(store.getProject(project.id), store.getSession('S-fork'));
const doc = readProjectDoc(store.getProject(project.id));
check('doc lives under PROJECTS_DIR', doc.path.startsWith(process.env.PROJECTS_DIR), true);
check('doc logs the root session', doc.content.includes('S-root'), true);
check('doc logs the fork', doc.content.includes('S-fork'), true);
check('doc carries the description', doc.content.includes('ES out, PG in.'), true);

// A deleted doc is rebuilt rather than silently skipped.
fs.unlinkSync(doc.path);
appendProjectSession(store.getProject(project.id), store.getSession('S-other'));
check('a missing doc is recreated on the next append', readProjectDoc(store.getProject(project.id)).content.includes('S-other'), true);

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
