// Testing tab: Jev browser-test runs from ~/jev-qa, streamed step by step.
// A run is a directory under ~/jev-qa/runs/<id>/ written by jev-qa/bin/start.sh:
//   run.json       { id, kind, title, env, sessionId, specs, status, result, startedAt, endedAt, summary }
//   events.jsonl   one line per step ({ type: spec_start | step | spec_end | verify, ... })
//   shots/*.jpg    a screenshot per step
// The dashboard only reads these (and shells out to start.sh to launch) — the runner itself never needs the dashboard,
// so a run started from a terminal shows up here exactly like one started from the UI.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const QA_DIR = process.env.JEV_QA_DIR || '/home/ubuntu/jev-qa';
const RUNS_DIR = path.join(QA_DIR, 'runs');
const ID_RE = /^[0-9TZ]+-[0-9a-f]{8}$/;          // start.sh ids only — legacy runner dirs (2026-…-spec) are not runs

function readRun(id) {
    try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'run.json'), 'utf8')); } catch { return null; }
}
// A sanity run is a parent whose children (one chain per assessment type, in parallel) are runs of their own.
// The parent's run.json only carries the children's ids/types until the supervisor finalises it, so read each
// child's live status/result/summary here — the list and the run page stay live without a second poller.
function withChildren(r) {
    if (!r || !Array.isArray(r.children)) return r;
    r.children = r.children.map((c) => { const cr = readRun(c.id); return cr ? { ...c, status: cr.status, result: cr.result || null, summary: cr.summary || null, startedAt: cr.startedAt, endedAt: cr.endedAt || null, assessment: cr.assessment || null, port: cr.port } : c; });
    return r;
}
function readEvents(id, after = 0) {
    let text = '';
    try { text = fs.readFileSync(path.join(RUNS_DIR, id, 'events.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(after).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function listRuns({ sessionId, limit = 100 } = {}) {
    let ids = [];
    try { ids = fs.readdirSync(RUNS_DIR).filter((d) => ID_RE.test(d)); } catch { return []; }
    // children of a sanity run are shown under their parent, not as top-level rows
    const runs = ids.sort().reverse().map(readRun).filter(Boolean).filter((r) => !r.parentId).map(withChildren);
    return (sessionId ? runs.filter((r) => r.sessionId === sessionId) : runs).slice(0, limit);
}

// The task handed to an "Ask Jev to test it" tester fork. One builder for every entry point (deploy banner, sprint row)
// so the instructions never drift. `subject` says what to test, `notes` is whatever the person typed in the dialog.
export function jevTask({ env = 'dev', device = 'pc', browser = 'chromium', notes = '', subject = 'the work in this session' }) {
    const eff = device === 'ios' ? 'webkit' : browser;
    const e = String(env).toLowerCase();
    return [
        `Test ${subject} on ${e.toUpperCase()} with Jev (use the jev-e2e skill; jev-take-assessment if the candidate flow is involved). Device: ${device}, browser: ${eff}${device === 'ios' ? ' (iOS = Safari/WebKit; the candidate flow cannot run there — WebKit has no camera/mic, use android for that)' : ''} — already chosen, do not ask again.`,
        notes.trim() ? `Notes from the person who asked (treat as requirements/focus):\n${notes.trim()}` : null,
        `1. From this session's history, the feature description and the diff of the pushed commits, list the user-visible behaviours that changed (screens, buttons, flows, API calls).`,
        `2. Reuse specs in ~/jev-qa/specs/ where they already cover a behaviour; otherwise write one spec per behaviour in ~/jev-qa/specs/<feature>.mjs (plain-English steps, assert claims, request checks). Iterate the wording with ~/jev-qa/bin/run.sh <spec> --env ${e} --until N until every step is green or a real failure is isolated.`,
        `3. Start the final run so it streams to the Testing tab: ~/jev-qa/bin/start.sh <spec …> --env ${e} --device ${device} --browser ${eff} — post "Test started — watch it here: <link>" immediately, then poll ~/jev-qa/runs/<id>/run.json until status is done (up to 10 minutes) and report.`,
        `4. Report WHAT + WHY for every failure (spec-wording problems are yours to fix, product bugs are reported, never fixed). Product repos are read-only for you; specs under ~/jev-qa/ are yours.`,
    ].filter(Boolean).join('\n');
}

export function registerTestRoutes(app, { requireAuth, store }) {
    const withSession = (r) => {
        if (!r?.sessionId || !store?.getSession) return r;
        try { const s = store.getSession(r.sessionId); if (s) r.session = { id: s.id, name: s.name || s.task?.slice(0, 80) || null }; } catch { /* ignore */ }
        return r;
    };

    app.get('/api/tests', requireAuth, (req, res) => {
        res.json({ runs: listRuns({ sessionId: req.query.session || null, limit: Math.min(+req.query.limit || 100, 500) }).map(withSession) });
    });

    app.get('/api/tests/:id', requireAuth, (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad run id' });
        const run = withChildren(readRun(req.params.id));
        if (!run) return res.status(404).json({ error: 'run not found' });
        res.json({ run: withSession(run), events: readEvents(req.params.id) });
    });

    // Poll while a run is live: ?after=<number of events already seen>
    app.get('/api/tests/:id/events', requireAuth, (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad run id' });
        const run = withChildren(readRun(req.params.id));
        if (!run) return res.status(404).json({ error: 'run not found' });
        res.json({ status: run.status, result: run.result || null, summary: run.summary || null, children: run.children || null, events: readEvents(req.params.id, Math.max(0, +req.query.after || 0)) });
    });

    app.get('/api/tests/:id/shot/:file', requireAuth, (req, res) => {
        if (!ID_RE.test(req.params.id) || !/^[\w.-]+\.jpg$/.test(req.params.file)) return res.status(400).end();
        const p = path.join(RUNS_DIR, req.params.id, 'shots', req.params.file);
        if (!fs.existsSync(p)) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.sendFile(p);
    });

    app.post('/api/tests/:id/stop', requireAuth, (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad run id' });
        if (!readRun(req.params.id)) return res.status(404).json({ error: 'run not found' });
        execFile('bash', [path.join(QA_DIR, 'bin', 'stop.sh'), req.params.id], { cwd: QA_DIR, timeout: 15000 }, (err, stdout, stderr) => {
            if (err) return res.status(500).json({ error: (stderr || err.message).trim().split('\n')[0] });
            res.json({ ok: true, run: readRun(req.params.id), message: stdout.trim() });
        });
    });

    // Launch from the UI. body: { target: 'suite' | 'chain' | 'sanity' | '<spec>' | ['spec', …], env: 'dev'|'uat'|'prod', sessionId?, type?, types? }
    // 'sanity' = every assessment type in parallel (one child chain each + a Mix & Match float); it is the ONLY target
    // start.sh accepts on PROD, and there it is confined to the QA entity/candidate configured in ~/jev-qa/.env.
    app.post('/api/tests/run', requireAuth, (req, res) => {
        const { target, env = 'dev', sessionId, type, types, device = 'pc', browser = 'chromium' } = req.body || {};
        if (!['pc', 'android', 'ios'].includes(device) || !['chromium', 'firefox', 'webkit'].includes(browser)) return res.status(400).json({ error: 'bad device/browser' });
        const specs = Array.isArray(target) ? target : [String(target || 'suite')];
        if (!['dev', 'uat', 'prod'].includes(env)) return res.status(400).json({ error: 'env must be dev, uat or prod' });
        if (env === 'prod' && specs[0] !== 'sanity') return res.status(400).json({ error: 'PROD is only a target for the sanity run' });
        if (!specs.every((s) => /^[\w-]+$/.test(s))) return res.status(400).json({ error: 'bad spec name' });
        const args = [...specs]; if (specs[0] === 'chain') args.push(String(type || 'Aptitude').replace(/[^\w]/g, ''));
        if (specs[0] === 'sanity' && types) { if (!/^[\w,]+$/.test(String(types))) return res.status(400).json({ error: 'bad types' }); args.push('--types', String(types)); }
        args.push('--env', env, '--device', device, '--browser', browser); if (sessionId) args.push('--session', String(sessionId));
        execFile('bash', [path.join(QA_DIR, 'bin', 'start.sh'), ...args], { cwd: QA_DIR, timeout: 30000 }, (err, stdout, stderr) => {
            if (err) return res.status(500).json({ error: (stderr || err.message).trim().split('\n')[0] });
            const id = (stdout.match(/tests\/(\S+)/) || [])[1];
            const url = (stdout.match(/Watch it here: (\S+)/) || [])[1];
            res.json({ id, url, run: id ? readRun(id) : null });
        });
    });
}
