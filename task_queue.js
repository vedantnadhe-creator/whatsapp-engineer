// task_queue.js — a developer's own task queue.
//
// Pick issues assigned to you, queue them, and they run as agent sessions N at a time
// (1–3, per person). When a session finishes it ends its reply with a marker:
//
//   [[TASK_DONE]]                 → Jev on:  a Jev QA fork tests the change on DEV
//                                   Jev off: the card moves to Dev Completed
//   [[NEEDS_INPUT: <question>]]   → the item waits for the developer; the issue is tagged
//                                   "question" and the personal agent posts the link
//
// A Jev fork ends with [[JEV_VERDICT: PASS|FAIL|BLOCKED]]. PASS → Done (QA pass).
// FAIL/BLOCKED → Dev Completed, and the item waits for the developer like a question.
//
// Markers, not free text, because the runner acts on them: a line of prose like "I think
// this is done" must not move a card. A turn that ends with no marker is treated as a
// question — a person looks at it — never as success.
import config from './config.js';
import { jevTask } from './test_runs.js';
import { logIssueEvent } from './project_events.js';

export const MAX_PARALLEL = 3;
const QUESTION_TAG = 'question';
// A turn that ends on a broken promise is auto-continued by ClaudeManager right after
// session_end fires. Wait this long before deciding the session is really idle.
const SETTLE_MS = 2500;
const TICK_MS = 60_000;
const NOTE_MAX = 4000;

const DONE_RE = /^\s*\[\[TASK_DONE\]\]\s*$/m;
const INPUT_RE = /\[\[NEEDS_INPUT:\s*([\s\S]*?)\]\]/g;
const VERDICT_RE = /\[\[JEV_VERDICT:\s*(PASS|FAIL|BLOCKED)\s*\]\]/gi;

const stripThinking = (t) => String(t || '').replace(/<!--thinking-->[\s\S]*?<!--\/thinking-->/g, '');
const lastMatch = (re, text) => { let m, last = null; re.lastIndex = 0; while ((m = re.exec(text))) last = m; return last; };
const nowIso = () => new Date().toISOString();

/** Parse a finished turn. Exported for the test — this is the logic that moves cards. */
export function readMarkers(text) {
    const body = stripThinking(text);
    const verdict = lastMatch(VERDICT_RE, body);
    const input = lastMatch(INPUT_RE, body);
    return {
        done: DONE_RE.test(body),
        question: input ? input[1].trim().slice(0, 1000) || 'The agent needs your input.' : null,
        verdict: verdict ? verdict[1].toUpperCase() : null,
    };
}

export default class TaskQueue {
    /**
     * @param {object} d
     * @param {object} d.store
     * @param {object} d.engine          ClaudeManager
     * @param {Function} d.messageHandler dashboard message handler (starts web sessions)
     * @param {Function} d.broadcast     wsBroadcast
     * @param {Function} d.resolveModel  (role, model) => model the role may use
     * @param {string}   d.testingModel  model every Jev session runs on (mandated)
     * @param {Function} d.notify        (userId, markdown) => void — personal agent feed
     */
    constructor({ store, engine, messageHandler, broadcast, resolveModel, testingModel, notify }) {
        Object.assign(this, { store, engine, messageHandler, broadcast, resolveModel, testingModel, notify: notify || (() => { }) });
        this.pumping = new Set(); // userIds mid-pump, so two events cannot start the same slot twice
        engine.on('session_end', ({ sessionId, status }) => {
            if (!this.store.getQueueItemBySession(sessionId)) return;
            setTimeout(() => this._settle(sessionId, status).catch(err => console.error('[TaskQueue]', err.message)), SETTLE_MS);
        });
        // Boot: sessions that finished while the dashboard was down never fired session_end.
        setTimeout(() => this.reconcile(), 10_000);
        setInterval(() => { for (const u of this.store.getQueueUserIds()) this.pump(u); }, TICK_MS).unref?.();
    }

    // ── settings ────────────────────────────────────────────────────────────
    settings(userId) {
        let s = {};
        try { s = JSON.parse(this.store.getSetting(`task_queue:${userId}`) || '{}'); } catch { /* defaults */ }
        return {
            parallel: Math.min(MAX_PARALLEL, Math.max(1, +s.parallel || 1)),
            device: ['pc', 'android', 'ios'].includes(s.device) ? s.device : 'pc',
            browser: ['chromium', 'firefox', 'webkit'].includes(s.browser) ? s.browser : 'chromium',
        };
    }

    saveSettings(userId, patch) {
        const next = { ...this.settings(userId), ...patch };
        delete next.paused; // legacy global flag — Run/Stop now live on the tasks themselves
        this.store.setSetting(`task_queue:${userId}`, JSON.stringify(next));
        this._changed(userId);
        this.pump(userId);
        return this.settings(userId);
    }

    // ── pumping ─────────────────────────────────────────────────────────────
    async pump(userId) {
        if (this.pumping.has(userId)) return;
        this.pumping.add(userId);
        try {
            // Only tasks armed by Run are started. A task queued after Run stays unarmed until
            // the next Run, so adding never starts anything — and there is no global on/off
            // flag that can go stale and quietly start the next thing you add.
            const { parallel } = this.settings(userId);
            const items = this.store.getQueueItems(userId);
            let live = items.filter(i => i.status === 'running' || i.status === 'testing').length;
            for (const item of items.filter(i => i.status === 'queued' && i.armed)) {
                if (live >= parallel) break;
                if (await this._start(item)) live++;
            }
        } catch (err) {
            console.error(`[TaskQueue] pump ${userId}: ${err.message}`);
        } finally {
            this.pumping.delete(userId);
        }
    }

    _brief(issue, item, user) {
        const bugs = (this.store.getBugsByIssue(issue.id) || []).filter(b => b.status === 'open' || b.status === 'fixing');
        return [
            `Title: ${issue.title}`,
            issue.platform ? `Platform: ${issue.platform}` : null,
            issue.description ? `Description: ${issue.description}` : null,
            issue.qa_comments ? `QA comments: ${issue.qa_comments}` : null,
            item.note ? `\nInstructions from ${user?.display_name || 'the developer'} for this run (these take priority):\n${item.note}` : null,
            bugs.length ? `Open bugs on this item:\n${bugs.map(b => `- ${b.title}${b.severity === 'critical' ? ' [CRITICAL]' : ''}`).join('\n')}` : null,
            '',
            `[TASK QUEUE] ${user?.display_name || 'The developer'} queued this task to run on its own — nobody is watching live, so work autonomously to completion. Follow CLAUDE.md.`,
            item.jev
                ? '- Jev testing is ON: when the change is committed, push it to the repo\'s Development branch and make sure it is live on DEV (DEV only — queueing this task is the explicit authorization for that DEV deploy, never UAT/PROD). Jev QA tests it on DEV right after you finish.'
                : '- Jev testing is OFF: commit and push to the repo\'s Development branch. Do not run deploy scripts.',
            '- If you need a decision only the developer can make (unclear requirement, a choice between approaches, missing access or data), do not guess: ask one clear question and stop.',
            '- End your final reply with exactly one of these on its own last line:',
            '  [[TASK_DONE]]  — the task is implemented and pushed; nothing left for a human.',
            '  [[NEEDS_INPUT: <the question, one line>]]  — you are blocked on the developer.',
        ].filter(v => v !== null).join('\n');
    }

    // Returns true when a slot was actually taken.
    async _start(item) {
        const issue = this.store.getIssue(item.issue_id);
        if (!issue) { this.store.deleteQueueItem(item.id); this._changed(item.user_id); return false; }
        const user = this.store.getUserById(item.user_id);
        const model = this.resolveModel(user?.role, item.model || 'claude-opus-5-5');
        const brief = this._brief(issue, item, user);
        let sessionId;

        const existing = issue.session_id ? this.store.getSession(issue.session_id) : null;
        if (existing?.claude_session_id) {
            // Keep the feature's context: continue its dev session rather than starting cold.
            // Someone is in it right now → leave the item queued; the next tick retries.
            if (this.engine.isRunning(existing.id)) return false;
            await this.engine.resumeSession(existing.id, brief, null, model);
            sessionId = existing.id;
        } else {
            const r = await this.messageHandler({
                isWeb: true, phone: String(user?.phone || user?.email || item.user_id), text: `[start fresh] ${brief}`,
                pushName: user?.display_name || 'Task queue', ownerId: item.user_id, model, mode: 'developer',
            });
            sessionId = r?.sessionId;
            if (!sessionId) throw new Error(`could not start a session for ${issue.id}`);
            this.store.updateSession(sessionId, { sprint_id: issue.sprint_id || null, type: issue.type || 'feature', name: issue.title.slice(0, 120), mode: 'developer' });
        }
        this.store.updateQueueItem(item.id, { status: 'running', phase: 'dev', dev_session_id: sessionId, started_at: nowIso(), question: null });
        this._setIssue(issue, { session_id: sessionId, dev_status: 'in_progress' }, null);
        this._changed(item.user_id);
        return true;
    }

    // ── outcomes ────────────────────────────────────────────────────────────
    async _settle(sessionId, status) {
        if (this.engine.isRunning(sessionId)) return; // auto-continued; its own end will come
        const item = this.store.getQueueItemBySession(sessionId);
        if (!item) return;
        const last = this.store.getMessages(sessionId, 20).filter(m => m.role === 'assistant').pop();
        const marks = readMarkers(last?.content);
        const failed = status === 'failed';

        if (sessionId === item.jev_session_id) {
            const verdict = marks.verdict || 'BLOCKED';
            this.store.updateQueueItem(item.id, { verdict });
            if (verdict === 'PASS') return this._finish(item, 'done');
            this._setIssue(this.store.getIssue(item.issue_id), { dev_status: 'dev_completed', qa_status: 'fail' }, `🧪 Jev: ${verdict}`);
            return this._ask(item, 'jev', verdict === 'FAIL'
                ? 'Jev found bugs it could not fix — open the test session for what failed.'
                : (failed ? 'The Jev session stopped with an error before a verdict.' : 'Jev could not test it — open the test session for what is blocking it.'));
        }

        if (marks.question) return this._ask(item, 'dev', marks.question);
        if (marks.done && !failed) return item.jev ? this._startJev(item) : this._finish(item, 'dev_completed');
        return this._ask(item, 'dev', failed
            ? 'The session stopped with an error. Open it and send a message to resume.'
            : 'The session ended without finishing or asking — open it to see where it got to.');
    }

    async _startJev(item) {
        const issue = this.store.getIssue(item.issue_id);
        const user = this.store.getUserById(item.user_id);
        const { device, browser } = this.settings(item.user_id);
        const task = jevTask({
            env: 'dev', device, browser, deployed: true,
            subject: `the queued task "${issue.title}"${issue.platform ? ` (${issue.platform})` : ''}`,
            notes: 'Priority: the changes made in THIS session\'s commits. Write the goals from that diff first; anything else only after.',
        }) + '\n7. End your final report with exactly one line: [[JEV_VERDICT: PASS]] (every goal PASS), [[JEV_VERDICT: FAIL]] (a bug is still open) or [[JEV_VERDICT: BLOCKED]] (could not test).';
        const r = await this.engine.forkSession(item.dev_session_id, task, String(user?.phone || user?.email || item.user_id), item.user_id,
            this.testingModel, { mode: 'tester', editAccess: user?.can_edit !== 0 });
        if (!r?.sessionId) return this._ask(item, 'jev', 'Jev could not be started for this task.');
        this.store.updateSession(r.sessionId, { sprint_id: issue.sprint_id || null, name: `Jev test: ${issue.title}`.slice(0, 120) });
        this.store.updateQueueItem(item.id, { status: 'testing', phase: 'jev', jev_session_id: r.sessionId, question: null });
        this._setIssue(issue, { qa_session_id: r.sessionId, qa_status: 'testing', dev_status: 'dev_completed' }, null);
        this._untag(issue);
        this._changed(item.user_id);
    }

    _finish(item, outcome) {
        const issue = this.store.getIssue(item.issue_id);
        if (outcome === 'done') this._setIssue(issue, { dev_status: 'done', qa_status: 'pass' }, `✅ "${issue?.title}" → Done (Jev PASS)`);
        else this._setIssue(issue, { dev_status: 'dev_completed' }, `📋 "${issue?.title}" → Dev Completed (task queue)`);
        this._untag(issue);
        this.store.updateQueueItem(item.id, { status: outcome, question: null, finished_at: nowIso() });
        const link = this._link(outcome === 'done' ? item.jev_session_id || item.dev_session_id : item.dev_session_id);
        this.notify(item.user_id, `${outcome === 'done' ? '✅' : '☑️'} **${issue?.title}** → ${outcome === 'done' ? 'Done — Jev passed it' : 'Dev Completed'}. [Open session](${link})`);
        this._changed(item.user_id);
        this.pump(item.user_id);
    }

    _ask(item, phase, question) {
        const issue = this.store.getIssue(item.issue_id);
        const sessionId = phase === 'jev' ? item.jev_session_id : item.dev_session_id;
        this.store.updateQueueItem(item.id, { status: 'needs_input', phase, question });
        if (issue) {
            const labels = this._labels(issue);
            if (!labels.includes(QUESTION_TAG)) this._setIssue(issue, { labels: [...labels, QUESTION_TAG] }, null);
        }
        this.notify(item.user_id, `❓ **${issue?.title || item.issue_id}** needs your input:\n\n> ${question}\n\n[Open the session](${this._link(sessionId)}) and reply there — the queue picks it back up when that session finishes.`);
        this._changed(item.user_id);
        this.pump(item.user_id); // a waiting item frees its slot
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    _labels(issue) { try { const a = JSON.parse(issue.labels || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }

    _untag(issue) {
        if (!issue) return;
        const labels = this._labels(issue);
        if (labels.includes(QUESTION_TAG)) this._setIssue(this.store.getIssue(issue.id), { labels: labels.filter(l => l !== QUESTION_TAG) }, null);
    }

    // Same side effects as PUT /api/issues/:id: kanban status follows dev_status.
    _setIssue(issue, patch, event) {
        if (!issue) return;
        const updates = { ...patch };
        if (updates.dev_status) {
            updates.status = { todo: 'todo', in_progress: 'in_progress', dev_completed: 'in_progress', done: 'completed' }[updates.dev_status];
            if (updates.dev_status === 'done') { updates.completed_at = nowIso(); updates.dev_percent = 100; }
        }
        const updated = this.store.updateIssue(issue.id, updates);
        if (updated) this.broadcast('issue_updated', { issue: updated });
        if (event && updated) logIssueEvent(this.store, updated, event);
    }

    _link(sessionId) { return `${config.PUBLIC_URL}${config.BASE_PATH}/s/${sessionId}`; }
    _changed(userId) { this.broadcast('task_queue_updated', { userId }); }

    reconcile() {
        for (const item of this.store.getLiveQueueItems()) {
            const sid = item.status === 'testing' ? item.jev_session_id : item.dev_session_id;
            if (sid && !this.engine.isRunning(sid)) this._settle(sid, this.store.getSession(sid)?.status).catch(err => console.error('[TaskQueue]', err.message));
        }
        for (const u of this.store.getQueueUserIds()) this.pump(u);
    }

    // ── routes ──────────────────────────────────────────────────────────────
    register(app, requireAuth) {
        const own = (req, res) => {
            const item = this.store.getQueueItem(req.params.id);
            if (!item || item.user_id !== req.user.id) { res.status(404).json({ error: 'Queue item not found' }); return null; }
            return item;
        };
        const withLinks = (i) => ({
            ...i,
            dev_session_url: i.dev_session_id ? this._link(i.dev_session_id) : null,
            jev_session_url: i.jev_session_id ? this._link(i.jev_session_id) : null,
        });
        const view = (userId) => {
            const items = this.store.getQueueItems(userId);
            const queued = items.filter(i => i.status === 'queued');
            return {
                settings: this.settings(userId),
                // armed = will start (Run was pressed); waiting = queued since, needs another Run.
                run: { armed: queued.filter(i => i.armed).length, waiting: queued.filter(i => !i.armed).length },
                items: items.map(withLinks),
            };
        };

        // My plate: every unfinished issue assigned to me, with its queue state.
        // Unfinished issues assigned to one person, each with its queue state.
        const plate = (userId) => {
            const all = this.store.getIssuesAssignedTo(userId, { status: 'all' }).filter(i => i.dev_status !== 'done');
            const queue = this.store.getQueueItems(userId);
            const byIssue = new Map(queue.filter(q => ['queued', 'running', 'testing', 'needs_input'].includes(q.status)).map(q => [q.issue_id, q]));
            return { all, queue, issues: all.map(i => ({ ...i, queue_status: byIssue.get(i.id)?.status || null, queue_item_id: byIssue.get(i.id)?.id || null })) };
        };
        const teamIds = (req, res) => {
            if (!req.query.users) return [];
            const ids = [...new Set(String(req.query.users).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 50);
            if (ids.some(id => id !== req.user.id) && !req.user.isAdmin) { res.status(403).json({ error: 'Only admins can view other people\'s work' }); return null; }
            return ids.filter(id => id !== req.user.id && this.store.getUserById(id));
        };

        // My plate. ?users=id1,id2 (admins): also each of those people's assigned tasks, as
        // `team_issues` labelled with the person — read-only, the queue only runs as its owner.
        app.get('/api/my/work', requireAuth, (req, res) => {
            try {
                const ids = teamIds(req, res); if (ids === null) return;
                const { all, queue, issues } = plate(req.user.id);
                const counts = { total: all.length, todo: 0, in_progress: 0, dev_completed: 0 };
                for (const i of all) if (counts[i.dev_status] !== undefined) counts[i.dev_status]++;
                const out = { counts, questions: queue.filter(q => q.status === 'needs_input').length, issues };
                if (ids.length) {
                    out.team_issues = ids.flatMap(id => {
                        const name = this.store.getUserById(id)?.display_name || id;
                        return plate(id).issues.map(i => ({ ...i, user_id: id, user_name: name }));
                    });
                }
                res.json(out);
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // ?users=id1,id2 — admins can watch several people's queues at once (read-only).
        app.get('/api/my/queue', requireAuth, (req, res) => {
            try {
                const ids = teamIds(req, res); if (ids === null) return;
                const out = view(req.user.id);
                if (req.query.users) out.team = this.store.getQueueItemsForUsers(ids).map(withLinks);
                res.json(out);
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // Run: arm everything queued right now and start it. Stop: disarm what has not
        // started yet — tasks already running finish.
        app.post('/api/my/queue/run', requireAuth, async (req, res) => {
            try {
                const armed = this.store.armQueue(req.user.id, true);
                this._changed(req.user.id);
                await this.pump(req.user.id);
                res.json({ armed, ...view(req.user.id) });
            } catch (err) { res.status(500).json({ error: err.message }); }
        });
        app.post('/api/my/queue/stop', requireAuth, (req, res) => {
            try {
                this.store.armQueue(req.user.id, false);
                this._changed(req.user.id);
                res.json(view(req.user.id));
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // body: { issueIds: [...], jev: bool, model }
        app.post('/api/my/queue', requireAuth, (req, res) => {
            try {
                const { issueIds, jev = false, model = null, notes = {} } = req.body || {};
                if (!Array.isArray(issueIds) || !issueIds.length || issueIds.length > 50) return res.status(400).json({ error: 'issueIds must be a non-empty array (max 50)' });
                if (typeof notes !== 'object' || Array.isArray(notes) || Object.values(notes).some(n => typeof n !== 'string' || n.length > NOTE_MAX)) {
                    return res.status(400).json({ error: `notes must map issue ids to text (max ${NOTE_MAX} chars each)` });
                }
                // Only your own assignments — this queue runs as you.
                const mine = new Set(this.store.getIssuesAssignedTo(req.user.id, { status: 'all' }).map(i => i.id));
                const added = [], skipped = [];
                for (const id of [...new Set(issueIds.map(String))]) {
                    if (!mine.has(id)) { skipped.push({ id, reason: 'not assigned to you' }); continue; }
                    if (this.store.getActiveQueueItemForIssue(id)) { skipped.push({ id, reason: 'already queued' }); continue; }
                    added.push(this.store.createQueueItem({ userId: req.user.id, issueId: id, jev: !!jev, model: typeof model === 'string' ? model : null, note: (notes[id] || '').trim() || null }).id);
                }
                this._changed(req.user.id);
                this.pump(req.user.id);
                res.json({ added: added.length, skipped, ...view(req.user.id) });
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // body: { parallel: 1..3, device, browser }  (legacy `paused` maps to Stop/Run)
        app.put('/api/my/queue/settings', requireAuth, (req, res) => {
            try {
                const b = req.body || {}, patch = {};
                if (b.parallel !== undefined) {
                    const n = Number(b.parallel);
                    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) return res.status(400).json({ error: `parallel must be 1–${MAX_PARALLEL}` });
                    patch.parallel = n;
                }
                if (b.paused !== undefined) { this.store.armQueue(req.user.id, !b.paused); }
                if (b.device !== undefined) { if (!['pc', 'android', 'ios'].includes(b.device)) return res.status(400).json({ error: 'bad device' }); patch.device = b.device; }
                if (b.browser !== undefined) { if (!['chromium', 'firefox', 'webkit'].includes(b.browser)) return res.status(400).json({ error: 'bad browser' }); patch.browser = b.browser; }
                this.saveSettings(req.user.id, patch);
                res.json(view(req.user.id));
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // body: { jev?: bool, move?: 'up'|'down', note?: string }
        app.put('/api/my/queue/:id', requireAuth, (req, res) => {
            try {
                const item = own(req, res); if (!item) return;
                const { jev, move, note } = req.body || {};
                if (note !== undefined) {
                    // The note is read when the task starts, so it is only editable before then.
                    if (item.status !== 'queued') return res.status(409).json({ error: 'The description can only be edited while the task is queued' });
                    if (typeof note !== 'string' || note.length > NOTE_MAX) return res.status(400).json({ error: `note must be text (max ${NOTE_MAX} chars)` });
                    this.store.updateQueueItem(item.id, { note: note.trim() || null });
                }
                if (jev !== undefined) {
                    // Read at TASK_DONE time, so it can still change while the task runs.
                    if (!['queued', 'running'].includes(item.status)) return res.status(409).json({ error: 'Jev can only be toggled before the task finishes' });
                    this.store.updateQueueItem(item.id, { jev: jev ? 1 : 0 });
                }
                if (move === 'up' || move === 'down') {
                    if (item.status !== 'queued') return res.status(409).json({ error: 'Only queued items can be reordered' });
                    const queued = this.store.getQueueItems(req.user.id).filter(q => q.status === 'queued');
                    const at = queued.findIndex(q => q.id === item.id);
                    const other = queued[move === 'up' ? at - 1 : at + 1];
                    if (other) {
                        this.store.updateQueueItem(item.id, { position: other.position });
                        this.store.updateQueueItem(other.id, { position: item.position });
                    }
                }
                this._changed(req.user.id);
                res.json(view(req.user.id));
            } catch (err) { res.status(500).json({ error: err.message }); }
        });

        // Remove from the queue. A running task has a live session — stop that first.
        app.delete('/api/my/queue/:id', requireAuth, (req, res) => {
            try {
                const item = own(req, res); if (!item) return;
                if (item.status === 'running' || item.status === 'testing') return res.status(409).json({ error: 'This task is running — stop its session first, or let it finish' });
                if (item.status === 'needs_input') this._untag(this.store.getIssue(item.issue_id));
                this.store.deleteQueueItem(item.id);
                this._changed(req.user.id);
                res.json(view(req.user.id));
            } catch (err) { res.status(500).json({ error: err.message }); }
        });
    }
}
