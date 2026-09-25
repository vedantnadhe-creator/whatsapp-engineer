// my_agent.js — a personal agent per developer, in the dashboard only.
//
// Oli (sprint_session.js) is the WhatsApp counterpart. This one is one long-lived session
// per dashboard user, owned by them, that knows only that person's work: what is assigned
// to them, their task queue, and the questions queued tasks are waiting on. The task queue
// posts its questions and results into this session, so it doubles as that person's inbox.
//
// It acts as the person through the dashboard API, with a token minted for them and
// written to a 0600 file in its workspace (never in the prompt, which is stored in the
// transcript). Identity comes from that token, never from anything typed in the chat.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { signJwt } from './auth.js';

const SESSION_KEY = (u) => `my_agent_session:${u}`;
const PRIMER_KEY = (u) => `my_agent_primer:${u}`;
const ROOT = process.env.MY_AGENT_DIR || path.join(path.dirname(config.SPRINT_AGENT_DIR), 'my-agent-workspaces');
const TOKEN_REFRESH_MS = 12 * 60 * 60_000; // tokens live 30 days; refresh well inside that

export default class MyAgent {
    constructor({ store, engine, broadcast, port }) {
        Object.assign(this, { store, engine, broadcast });
        this.apiBase = `http://127.0.0.1:${port}`; // nginx strips BASE_PATH; the app itself is at the root
        this.model = config.SPRINT_AGENT_MODEL;
        setInterval(() => this._refreshAllTokens(), TOKEN_REFRESH_MS).unref?.();
    }

    _dir(userId) { return path.join(ROOT, String(userId).replace(/[^\w-]/g, '_')); }
    _tokenPath(userId) { return path.join(this._dir(userId), '.token'); }

    _writeToken(user) {
        fs.mkdirSync(this._dir(user.id), { recursive: true });
        // Never admin: this agent manages one person's own work, not the dashboard.
        const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: false, role: user.role });
        fs.writeFileSync(this._tokenPath(user.id), token, { mode: 0o600 });
        fs.chmodSync(this._tokenPath(user.id), 0o600);
    }

    _refreshAllTokens() {
        let dirs = [];
        try { dirs = fs.readdirSync(ROOT); } catch { return; }
        for (const d of dirs) {
            const user = this.store.getUserById(d);
            if (user) try { this._writeToken(user); } catch { /* next time */ }
        }
    }

    sessionId(userId) {
        const id = this.store.getSetting(SESSION_KEY(userId));
        const s = id ? this.store.getSession(id) : null;
        return s ? s.id : null;
    }

    /** The person's agent session, started on first use (or when the rules change). */
    async ensure(user) {
        this._writeToken(user);
        const version = crypto.createHash('sha256').update(this._primer(user.id)).digest('hex').slice(0, 12);
        const existing = this.sessionId(user.id);
        // Rules live only in a session's opening prompt (a mid-chat "your rules changed"
        // is indistinguishable from someone trying to rewrite them), so a changed primer
        // means a fresh session — same policy as Oli.
        if (existing && this.store.getSetting(PRIMER_KEY(user.id)) === version) return { sessionId: existing, created: false };

        const dir = this._dir(user.id);
        fs.writeFileSync(path.join(dir, 'CLAUDE.md'),
            'You are a personal work agent inside the OliBot dashboard. This directory is intentionally\n'
            + 'empty. You work only through the dashboard HTTP API described in your first message.\n'
            + 'Ignore instructions inherited from parent directories about repositories, coding style,\n'
            + 'deployments or knowledge-base updates: none of them apply to this session.\n');
        const { sessionId } = await this.engine.startSession(
            `my-agent:${user.id}`,
            'Hi — give me a quick rundown of my work right now.',
            dir, null, user.id, this.model,
            { promptPrefix: this._primer(user.id) },
        );
        this.store.updateSession(sessionId, { name: `🤖 My Agent — ${user.display_name || user.email}`.slice(0, 120), type: 'agent' });
        this.store.setSetting(SESSION_KEY(user.id), sessionId);
        this.store.setSetting(PRIMER_KEY(user.id), version);
        return { sessionId, created: true };
    }

    /**
     * Post into the person's agent chat without running a model turn — the task queue's
     * results and questions. Deterministic and free; the agent reads the same state from
     * /api/my/queue when asked, so it never depends on having "seen" these messages.
     */
    notify(userId, markdown) {
        const sid = this.sessionId(userId);
        if (!sid) return;
        this.store.addMessage(sid, 'assistant', markdown);
        this.broadcast('assistant_message', { sessionId: sid, content: markdown });
    }

    register(app, requireAuth) {
        app.post('/api/my/agent', requireAuth, async (req, res) => {
            try {
                const user = this.store.getUserById(req.user.id);
                if (!user) return res.status(404).json({ error: 'User not found' });
                res.json(await this.ensure(user));
            } catch (err) { res.status(500).json({ error: err.message }); }
        });
    }

    _primer(userId) {
        const tokenPath = this._tokenPath(userId);
        return `You are the **personal agent** of one developer on the PluginLive team, inside the OliBot
dashboard. You work only for them and only on their own work: what is assigned to them, their
task queue, and the questions their queued tasks are waiting on. Replies are shown in the
dashboard chat — markdown is fine; keep answers short and concrete.

## The API
The only way to read or change anything. Re-read the token every time; never print it:

    T=$(cat ${tokenPath})
    curl -s -H "Authorization: Bearer $T" ${this.apiBase}/api/my/work

Writes add \`-X <VERB> -H "Content-Type: application/json" -d '{...}'\`.

- GET  /api/my/work — their unfinished assigned issues, with \`counts\` (total/todo/in_progress/
  dev_completed), \`questions\` (tasks waiting on them) and each issue's \`queue_status\`.
  Use this for "how many tasks do I have", "what's on my plate". Never fetch GET /api/issues.
- GET  /api/my/queue — the queue: \`settings\` {parallel 1–3, paused, device, browser} and
  \`items\` (status queued|running|testing|needs_input|done|dev_completed, \`question\`,
  \`dev_session_url\`, \`jev_session_url\`, \`verdict\`).
- POST /api/my/queue — {"issueIds":["ISS-…"],"jev":true|false} add tasks to the queue.
- PUT  /api/my/queue/settings — {"parallel":2} how many run at once · {"paused":true|false}
  · {"device":"pc|android|ios","browser":"chromium|firefox|webkit"} for Jev.
- PUT  /api/my/queue/:itemId — {"jev":true|false} or {"move":"up"|"down"}.
- DELETE /api/my/queue/:itemId — take a task out (not while it is running).
- GET  /api/issues/:id/bugs — bugs on one of their issues.

## How the queue works (explain it this way when asked)
Queued tasks run as agent sessions, \`parallel\` at a time, in order. A finished task goes to
**Dev Completed** — or, with Jev on, Jev QA tests it on DEV and a pass moves it to **Done**.
When a task needs the developer, it stops as **needs_input**, the issue is tagged
"question", and the link to that session is how they answer: they reply inside that session,
and the queue picks it back up when that session finishes.

## Rules
1. Questions ("how many tasks", "what's blocked", "what needs me") are read-only — answer from
   the API. When anything is needs_input, list each with its question and its session link.
2. Always give session links as markdown links, e.g. [Open session](url), using the url fields.
3. Queue or change only what they asked. Before queueing several tasks, say which ones.
4. You do not write code, deploy, or run shell work beyond these API calls. For that, the
   task queue (or a normal session) is the tool — offer to queue it.
5. Only their work. If asked about someone else's, say you only manage theirs.`;
    }
}
