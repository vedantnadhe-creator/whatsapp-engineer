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
function readEvents(id, after = 0) {
    let text = '';
    try { text = fs.readFileSync(path.join(RUNS_DIR, id, 'events.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(after).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function listRuns({ sessionId, limit = 100 } = {}) {
    let ids = [];
    try { ids = fs.readdirSync(RUNS_DIR).filter((d) => ID_RE.test(d)); } catch { return []; }
    const runs = ids.sort().reverse().map(readRun).filter(Boolean);
    return (sessionId ? runs.filter((r) => r.sessionId === sessionId) : runs).slice(0, limit);
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
        const run = readRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'run not found' });
        res.json({ run: withSession(run), events: readEvents(req.params.id) });
    });

    // Poll while a run is live: ?after=<number of events already seen>
    app.get('/api/tests/:id/events', requireAuth, (req, res) => {
        if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad run id' });
        const run = readRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'run not found' });
        res.json({ status: run.status, result: run.result || null, summary: run.summary || null, events: readEvents(req.params.id, Math.max(0, +req.query.after || 0)) });
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

    // Launch from the UI. body: { target: 'suite' | 'chain' | '<spec>' | ['spec', …], env: 'dev'|'uat', sessionId?, type? }
    app.post('/api/tests/run', requireAuth, (req, res) => {
        const { target, env = 'dev', sessionId, type, device = 'pc', browser = 'chromium' } = req.body || {};
        if (!['pc', 'android', 'ios'].includes(device) || !['chromium', 'firefox', 'webkit'].includes(browser)) return res.status(400).json({ error: 'bad device/browser' });
        const specs = Array.isArray(target) ? target : [String(target || 'suite')];
        if (!['dev', 'uat'].includes(env)) return res.status(400).json({ error: 'env must be dev or uat' });
        if (!specs.every((s) => /^[\w-]+$/.test(s))) return res.status(400).json({ error: 'bad spec name' });
        const args = [...specs]; if (specs[0] === 'chain') args.push(String(type || 'Aptitude').replace(/[^\w]/g, ''));
        args.push('--env', env, '--device', device, '--browser', browser); if (sessionId) args.push('--session', String(sessionId));
        execFile('bash', [path.join(QA_DIR, 'bin', 'start.sh'), ...args], { cwd: QA_DIR, timeout: 15000 }, (err, stdout, stderr) => {
            if (err) return res.status(500).json({ error: (stderr || err.message).trim().split('\n')[0] });
            const id = (stdout.match(/tests\/(\S+)/) || [])[1];
            const url = (stdout.match(/Watch it here: (\S+)/) || [])[1];
            res.json({ id, url, run: id ? readRun(id) : null });
        });
    });
}
