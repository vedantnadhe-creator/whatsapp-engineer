// Private-session access check. Runs a throwaway dashboard on :18899 against a SNAPSHOT
// of sessions.db (the live DB is never written), then proves a private session is visible
// to its owner only.   Usage: node test_private_sessions.mjs [sessionId]
import Database from 'better-sqlite3';
import fs from 'fs';
import WS from 'ws';

const SNAP = '/tmp/private-sessions-test.db';
for (const f of [SNAP, `${SNAP}-wal`, `${SNAP}-shm`]) fs.rmSync(f, { force: true });
await new Database('./sessions.db', { readonly: true }).backup(SNAP);
process.env.DB_PATH = SNAP;

const { default: SessionStore } = await import('./session_store.js');
const { startDashboard } = await import('./dashboard.js');
const { signJwt } = await import('./auth.js');
const { default: config } = await import('./config.js');
const store = new SessionStore();
startDashboard(store, async () => {}, 18899);
await new Promise(r => setTimeout(r, 1500));

const SID = process.argv[2] || store.db.prepare(
    `SELECT s.id FROM sessions s JOIN session_collaborators c ON c.session_id = s.id AND c.user_id != s.owner_id LIMIT 1`).get().id;
store.updateSession(SID, { private: 0 }); // start from shared, whatever the live flag is
const session = store.getSession(SID);
const owner = store.getUserById(session.owner_id);
const otherAdmin = store.db.prepare('SELECT * FROM users WHERE is_admin = 1 AND id != ? LIMIT 1').get(owner.id);
const collaborator = store.db.prepare(
    'SELECT u.* FROM session_collaborators c JOIN users u ON u.id = c.user_id WHERE c.session_id = ? AND u.id != ? LIMIT 1').get(SID, owner.id);

const tok = u => signJwt({ id: u.id, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin, role: u.role });
const call = async (u, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:18899${path}`, { method, headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
};
const inList = async u => (await call(u, 'GET', `/api/sessions?q=${encodeURIComponent(SID)}`)).json.sessions.some(s => s.id === SID);
const wsFor = u => new Promise(res => {
    const ws = new WS('ws://127.0.0.1:18899/ws', { headers: { cookie: `${config.COOKIE_NAME}=${tok(u)}` } });
    ws.got = []; ws.on('message', m => ws.got.push(JSON.parse(m))); ws.on('open', () => res(ws));
});

let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

store.updateSession(SID, { private: 1 }); // no UI or API for this — set in the DB only
check('owner still lists it', await inList(owner));
check('owner reads messages', (await call(owner, 'GET', `/api/sessions/${SID}/messages`)).status === 200);
for (const [who, u] of [['other admin', otherAdmin], ['collaborator', collaborator]]) {
    check(`${who}: not listed`, !(await inList(u)));
    for (const [m, p, b] of [['GET', ''], ['GET', '/messages'], ['POST', '/message', { text: 'hi' }], ['GET', '/share-links']]) {
        check(`${who}: ${m} ${p || '/'} → 404`, (await call(u, m, `/api/sessions/${SID}${p}`, b)).status === 404);
    }
}
store.db.prepare(`INSERT INTO session_share_links (id, session_id, token, permission, created_by, expires_at)
                  VALUES ('shl_private_test', ?, 'tok_private_test', 'write', ?, '2099-01-01T00:00:00Z')`).run(SID, owner.id);
check('fresh share link redeem → 404', (await call(otherAdmin, 'POST', '/api/share/tok_private_test/redeem')).status === 404);
const [wo, wa] = [await wsFor(owner), await wsFor(otherAdmin)];
await call(owner, 'PUT', `/api/sessions/${SID}/stage`, { stage: session.stage || 'idea' });
await new Promise(r => setTimeout(r, 500));
check('ws: owner gets the event', wo.got.some(m => m.type === 'session_stage_updated'));
check('ws: other admin does not', !wa.got.some(m => m.type === 'session_stage_updated'));
{ const u = (await call(otherAdmin, 'GET', '/api/usage?range=week')).json;
  check('usage: no per-session or per-person data', !('sessions' in u) && !('users' in u) && !('models' in u)); }
store.updateSession(SID, { private: 0 });
check('other admin lists it again', await inList(otherAdmin));

for (const f of [SNAP, `${SNAP}-wal`, `${SNAP}-shm`]) fs.rmSync(f, { force: true });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
