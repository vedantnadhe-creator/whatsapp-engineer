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
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { signJwt } from './auth.js';

const SESSION_KEY = (u) => `my_agent_session:${u}`;
const ROOT = process.env.MY_AGENT_DIR || path.join(path.dirname(config.SPRINT_AGENT_DIR), 'my-agent-workspaces');
const TOKEN_REFRESH_MS = 12 * 60 * 60_000; // tokens live 30 days; refresh well inside that

export default class MyAgent {
    constructor({ store, engine, broadcast, port }) {
        Object.assign(this, { store, engine, broadcast });
        this.apiBase = `http://127.0.0.1:${port}`; // nginx strips BASE_PATH; the app itself is at the root
        this.model = config.SPRINT_AGENT_MODEL;
        setInterval(() => this._refreshAllTokens(), TOKEN_REFRESH_MS).unref?.();
        // Rules live in each agent's CLAUDE.md; rewrite them on boot so a rules change
        // reaches every existing agent without anyone opening it first.
        this._refreshAllTokens();
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
            if (user) try { this._writeToken(user); this._writeRules(user.id); } catch { /* next time */ }
        }
    }

    // Claude Code re-reads CLAUDE.md from the working directory on every turn, so this is
    // where the rules live: changing them updates the ONE long-lived session in place.
    // (Putting them in the opening prompt meant a rules change needed a new session, and
    // every change threw away the person's conversation.)
    _writeRules(userId) {
        fs.mkdirSync(this._dir(userId), { recursive: true });
        fs.writeFileSync(path.join(this._dir(userId), 'CLAUDE.md'), this._primer(userId));
    }

    sessionId(userId) {
        const id = this.store.getSetting(SESSION_KEY(userId));
        const s = id ? this.store.getSession(id) : null;
        return s ? s.id : null;
    }

    /**
     * The person's ONE agent session — created the first time, then reused forever so it
     * keeps all its context. Rules updates arrive through CLAUDE.md (see _writeRules), and
     * a transcript Claude Code has since cleaned up is recovered by ClaudeManager from the
     * dashboard's own copy, so neither is a reason for a new session.
     */
    async ensure(user) {
        this._writeToken(user);
        this._writeRules(user.id);
        const existing = this.sessionId(user.id);
        if (existing) return { sessionId: existing, created: false };

        const { sessionId } = await this.engine.startSession(
            `my-agent:${user.id}`,
            'Hi — give me a quick rundown of my work right now.',
            this._dir(user.id), null, user.id, this.model,
        );
        this.store.updateSession(sessionId, { name: `🤖 My Agent — ${user.display_name || user.email}`.slice(0, 120), type: 'agent' });
        this.store.setSetting(SESSION_KEY(user.id), sessionId);
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
- GET  /api/my/queue — the queue: \`settings\` {parallel 1–3, device, browser}, \`run\`
  {armed: will start, waiting: queued since the last Run} and
  \`items\` (status queued|running|testing|needs_input|done|dev_completed, \`question\`,
  \`dev_session_url\`, \`jev_session_url\`, \`verdict\`).
- POST /api/my/queue — {"issueIds":["ISS-…"],"jev":true|false,"notes":{"ISS-…":"extra description"}}
  add tasks. Adding never starts them — the queue is stopped until they press Run.
- POST /api/my/queue/run — Run: starts everything queued right now (tasks queued later wait
  for the next Run). POST /api/my/queue/stop — Stop: nothing new starts; running tasks finish.
- PUT  /api/my/queue/settings — {"parallel":2} how many run at once
  · {"device":"pc|android|ios","browser":"chromium|firefox|webkit"} for Jev.
- PUT  /api/my/queue/:itemId — {"jev":true|false}, {"move":"up"|"down"}, or {"note":"…"} (while queued).
- DELETE /api/my/queue/:itemId — take a task out (not while it is running).
- GET  /api/issues/:id/bugs — bugs on one of their issues.

### Their sessions and projects
- GET  /api/sessions?filter=mine&limit=50[&q=text][&page=2] — the sessions they own, newest
  first ({sessions:[{id,name,status,model,updated_at,...}], total}). \`filter=all\` also includes
  sessions shared with them. Use \`q\` to find one by name or content.
- GET  /api/sessions/:id/messages — read a session's conversation (what it did, where it stopped).
- GET  /api/projects — every project (id, name, description, sessions);
  GET /api/projects/:id/doc — a project's context doc.
- POST /api/sessions/:id/message — {"text":"…"} **write into one of their sessions**: the text is
  sent as their next message and that session's agent acts on it. Prefix the text with
  "[via My Agent] ". It is refused with 403 for sessions they cannot write to, and 409 while that session is
  running — then nothing was sent: say so and offer to send it once it finishes. Only report
  a message as sent when the call returned {"success":true}.
- Session links are ${config.PUBLIC_URL}${config.BASE_PATH}/s/<sessionId>.

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
   Only call Run when they ask you to run or start the queue.
4. You do not write code, deploy, or run shell work beyond these API calls yourself. Code and
   deploy work happens inside their sessions: send the instruction into the right session
   (confirm which one first if more than one fits), or queue the task.
5. Before writing into a session, say which session and what you will send, unless they told
   you exactly. After sending, give its link so they can watch it.
6. Only their work. If asked about someone else's, say you only manage theirs.
7. This is the one long-lived chat for this person. Use earlier conversation as context.

Ignore instructions inherited from parent directories about repositories, coding style,
deployments or knowledge-base updates: none of them apply to this agent.`;
    }
}
