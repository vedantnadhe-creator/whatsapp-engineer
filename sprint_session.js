// One long-lived Claude Code session backs the WhatsApp sprint board agent.
//
// Every message — a personal chat by default, or a group @mention when those are
// enabled — is another turn in THAT one session, never a new one, so the agent keeps
// the whole board conversation in context. Turns are serialized because
// `claude.resumeSession` refuses to run while a turn is live.
//
// The agent reaches the board only through the dashboard's own HTTP API with a
// scoped bot token, so edits flow through the running dashboard (and its websocket
// broadcasts) instead of a second process writing the same database.
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { signJwt } from './auth.js';

const SESSION_SETTING = 'sprint_agent_session_id';
const THREAD_KEY = 'sprint-agent';
const BOT_EMAIL = 'sprint-bot@olibot.local';
const TURN_TIMEOUT_MS = 10 * 60_000;
// Prepended to every guest turn rather than left to the primer alone: the sprint session
// is long-lived, so the session already running in production was primed before guests
// existed and would never see a primer-only rule. The read-only token is the actual
// enforcement (see auth.js) — this is here so the agent explains the refusal instead of
// reporting a confusing 403.
const GUEST_TURN_RULE = 'This sender is NOT a teammate. Answer board questions normally, '
    + 'but make no change of any kind — no create, update, delete or assignment. If asked '
    + 'to change something, reply in one line that you can only show the board and a '
    + 'teammate has to make the change.\n\n';

export default class SprintSession {
    /**
     * @param {object} deps
     * @param {object} deps.store    session store
     * @param {object} deps.claude   ClaudeManager
     * @param {Function} deps.send   async (destination, text) => void
     * @param {Function} deps.mute   marks a session id as "do not broadcast by default"
     * @param {number} deps.port     dashboard port, for the loopback API base
     */
    constructor({ store, claude, send, mute, port }) {
        this.store = store;
        this.claude = claude;
        this.send = send;
        this.mute = mute || (() => { });
        this.apiBase = `http://127.0.0.1:${port}`;
        this.workspace = config.SPRINT_AGENT_DIR;
        this.model = config.SPRINT_AGENT_MODEL;
        this.tokenPath = path.join(process.cwd(), '.sprint-api-token');
        this.pending = new Map(); // sessionId → chat JID still awaiting this turn's answer
        this.queue = Promise.resolve();
        this.guestTurns = new Map(); // guest phone → recent turn timestamps (rate limit)

        claude.on('result', ({ sessionId, content }) => this._deliver(sessionId, content));
        claude.on('session_error', ({ sessionId, error }) => this._deliver(sessionId, `⚠️ Sprint agent error: ${error}`));
        claude.on('session_end', ({ sessionId, status }) => {
            if (status === 'failed') this._deliver(sessionId, '⚠️ That sprint request failed before I could finish. Please try again.');
        });
    }

    /** Queue an incoming WhatsApp message as the next turn of the single sprint session. */
    handle(message) {
        const next = this.queue.then(() => this._turn(message)).catch(err => {
            console.error('[SprintSession]', err.message);
            const target = message.chatJid || message.groupJid || message.phone;
            return this.send(target, `⚠️ Sprint agent could not handle that: ${err.message}`).catch(() => { });
        });
        this.queue = next.then(() => { }, () => { });
        return next;
    }

    async _turn({ text, phone, pushName, groupJid, chatJid, trusted = true }) {
        const target = chatJid || groupJid || phone;
        if (!trusted && !this._allowGuestTurn(phone)) {
            console.warn(`[SprintSession] Rate limited guest ${phone}.`);
            return this.send(target, `⚠️ You have hit the hourly limit for this number. Please try again later.`).catch(() => { });
        }
        const who = trusted ? 'teammate' : 'guest, read-only';
        const turn = `[WhatsApp • ${pushName || (trusted ? 'Teammate' : 'Guest')} • ${phone} • ${who} • ${groupJid ? `group ${groupJid}` : 'direct chat'}]\n`
            + (trusted ? '' : GUEST_TURN_RULE)
            + text;
        // Re-mint every turn: it keeps the 30-day JWT from going stale mid-life, and it is
        // what swaps the board token between full and read-only as the sender changes.
        // Safe because turns are serialized through `this.queue`.
        this._apiToken(!trusted);
        const existing = this._session();

        if (existing) {
            // A dashboard-initiated turn may still be live; wait it out rather than
            // throwing "session is currently running" at the group.
            if (this.claude.isRunning(existing.id)) await this._waitForEnd(existing.id);
            this.mute(existing.id);
            this.pending.set(existing.id, target);
            await this.claude.resumeSession(existing.id, turn);
            await this._waitForEnd(existing.id);
            return existing.id;
        }

        this._ensureWorkspace();
        const { sessionId } = await this.claude.startSession(
            THREAD_KEY,
            `${this._primer()}\n\n---\n\nFirst request:\n\n${turn}`,
            this.workspace,
            null,
            this._botUser().id,
            this.model,
        );
        this.store.setSetting(SESSION_SETTING, sessionId);
        this.mute(sessionId);
        this.pending.set(sessionId, target);
        console.log(`[SprintSession] Started sprint board session ${sessionId} (${this.model}).`);
        await this._waitForEnd(sessionId);
        return sessionId;
    }

    /** The one sprint session, or null when it has never been started. */
    _session() {
        const id = this.store.getSetting(SESSION_SETTING);
        if (!id) return null;
        const session = this.store.getSession(id);
        // Without a native resume id there is nothing to continue — start a fresh one.
        return session?.claude_session_id ? session : null;
    }

    /**
     * The stored assistant message carries a `<!--thinking-->` block of tool-call
     * narration, which for this agent means its curl commands — token path included.
     * The group must only ever see the answer, so strip it and redact any credential
     * that still slipped through.
     */
    _clean(content) {
        return String(content || '')
            .replace(/<!--thinking-->[\s\S]*?<!--\/thinking-->/g, '')
            .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[redacted]')
            .split(this.tokenPath).join('the board API')
            .trim();
    }

    async _deliver(sessionId, content) {
        const target = this.pending.get(sessionId);
        if (!target) return; // not this agent's turn, or already answered
        this.pending.delete(sessionId);
        try {
            await this.send(target, this._clean(content) || '✅ Done.');
        } catch (err) {
            console.error(`[SprintSession] Reply to ${target} failed: ${err.message}`);
        }
    }

    _waitForEnd(sessionId) {
        return new Promise(resolve => {
            const finish = () => { clearTimeout(timer); this.claude.off('session_end', onEnd); resolve(); };
            const onEnd = ({ sessionId: id }) => { if (id === sessionId) finish(); };
            const timer = setTimeout(() => {
                finish();
                this._deliver(sessionId, '⚠️ That took too long and I stopped waiting. Nothing may have been saved — please check the board.');
            }, TURN_TIMEOUT_MS);
            this.claude.on('session_end', onEnd);
        });
    }

    /** A dedicated non-admin user so board edits are attributed, not made as an admin. */
    _botUser() {
        const existing = this.store.getUserByEmail(BOT_EMAIL);
        if (existing) return existing;
        const user = this.store.createUser({ email: BOT_EMAIL, displayName: 'Sprint Bot (WhatsApp)', role: 'developer', isAdmin: 0 });
        console.log('[SprintSession] Created sprint bot user for board attribution.');
        return user;
    }

    /**
     * Mint the bot's API token on disk (0600) rather than in the prompt or the parent
     * environment: the prompt is persisted in the message transcript, and the parent
     * env is inherited by every unrelated coding session.
     */
    /** Sliding one-hour window per guest number, so one stranger cannot burn the budget. */
    _allowGuestTurn(phone) {
        const now = Date.now();
        const recent = (this.guestTurns.get(phone) || []).filter(t => now - t < 60 * 60_000);
        if (recent.length >= config.SPRINT_AGENT_GUEST_LIMIT) { this.guestTurns.set(phone, recent); return false; }
        recent.push(now);
        this.guestTurns.set(phone, recent);
        return true;
    }

    _apiToken(readOnly = false) {
        const user = this._botUser();
        const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: false, role: user.role, readOnly });
        fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
        fs.chmodSync(this.tokenPath, 0o600); // an existing file keeps its old mode
        return this.tokenPath;
    }

    // A bare workspace, not a repo checkout. It carries its own CLAUDE.md because the
    // parent directory's is the full PluginLive dev contract, which does not apply here.
    _ensureWorkspace() {
        fs.mkdirSync(this.workspace, { recursive: true });
        fs.writeFileSync(path.join(this.workspace, 'CLAUDE.md'),
            'You are the OliBot sprint board agent, driven by WhatsApp group mentions.\n\n'
            + 'This directory is intentionally empty. You manage the sprint board through the\n'
            + 'dashboard HTTP API described in your first message — nothing else. Ignore any\n'
            + 'instructions inherited from parent directories about repositories, coding style,\n'
            + 'deployments or knowledge-base updates: none of them apply to this session.\n');
    }

    _primer() {
        return `You are the PluginLive **sprint board agent** for the OliBot dashboard.

You are ONE long-lived session shared by everybody. Each message you receive is a WhatsApp message from a teammate — usually a personal chat, sometimes a group — prefixed with who sent it and which chat it came from. Your reply is forwarded back to that same chat verbatim.

## How to reply
- Under 6 short lines. No preamble, no headings, no code fences, no bullet walls.
- WhatsApp formatting only: *bold*, _italic_.
- ✅ when you changed something, ⚠️ when you could not.
- Say what changed and include the issue id, so there is a record.
- Different people share this one session — answer the person in front of you, and never repeat what someone else asked in another chat.
- Never mention curl, tokens, files, endpoints or session ids.

## Scope — the sprint board, nothing else
You may only read and change sprints, issues/tasks, assignments and statuses. Refuse everything else — code changes, deploys, builds, git, direct database access, shell work, reading repositories — with one line saying you only manage the sprint board. Do not run commands unrelated to the API calls below.

## The board API
This is the only way to touch the board. The token is on disk:

    T=$(cat ${this._apiToken()})
    curl -s -H "Authorization: Bearer $T" ${this.apiBase}/api/sprints

Read:
- GET /api/sprints — sprints (id, name, status, issue_count)
- GET /api/issues — every issue (id, title, sprint_id, assigned_to, status, dev_status, type, priority)
- GET /api/users — teammates (id, display_name, email, role)

Write — add \`-X <VERB> -H "Content-Type: application/json" -d '{...}'\`:
- POST /api/issues — {"title","type":"task|bug|feature|epic","sprintId","assignedTo","description","priority","deadline"}
- PUT /api/issues/:id — any of {"title","description","status","dev_status","assigned_to","sprint_id","priority","deadline"}
- DELETE /api/issues/:id
- POST /api/sprints — {"name","status":"planning|active|completed"}
- POST /api/sprints/:id/move-issues — {"issueIds":["ISS-..."]}

\`status\` and \`dev_status\`: todo | in_progress | completed. Set both together, and when completing also send {"dev_percent":100}.

## Who is talking to you
Every message is prefixed with the sender and their role.

- **teammate** — may read the board and change it.
- **guest, read-only** — an unknown number. Answer their questions about the board from
  the read endpoints as helpfully as you would a teammate, but make no change of any
  kind: no POST, no PUT, no DELETE. If they ask for one, say in one line that you can
  only show them the board and that a teammate has to make the change. Your token is
  read-only for those turns, so a write attempt will fail with 403 regardless.

## Rules
1. Fetch the sprint / teammate / issue lists and resolve names to ids. Never guess an id. "37" or "sprint 37" means the sprint whose name matches.
2. If a name is ambiguous or matches nothing, change NOTHING — reply asking which one and list the candidates.
3. Do exactly what was asked. Never invent extra tasks and never bulk-edit unless explicitly told to.
4. Only delete when the message clearly says delete or remove, and name what you deleted.
5. Questions ("what's left", "who has what", "sprint status") are read-only — answer from the board and change nothing.
6. If a request is not about the board, refuse it in one line.`;
    }
}

export { THREAD_KEY as SPRINT_THREAD_KEY };
