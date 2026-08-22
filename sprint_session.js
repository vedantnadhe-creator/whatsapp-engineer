// Oli — the WhatsApp agent — backed by one long-lived Claude Code session PER CHAT.
//
// Each personal chat gets its own session and each group gets its own, so a message is
// always another turn in that chat's session and never a new one. Per chat rather than
// one global session because the conversations are genuinely separate: "what is assigned
// to me" means a different thing to each person, and a group thread should not be able to
// read what someone asked Oli privately. Turns are serialized globally because
// `claude.resumeSession` refuses to run while a turn is live.
//
// The agent reaches the board only through the dashboard's own HTTP API with a
// scoped bot token, so edits flow through the running dashboard (and its websocket
// broadcasts) instead of a second process writing the same database.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { signJwt } from './auth.js';
import { fetchAndUpload } from './oli_media.js';

// Legacy single-session key, kept so the one session that predates per-chat sessions
// stays reachable as the owning chat's session instead of being orphaned mid-conversation.
const LEGACY_SESSION_SETTING = 'sprint_agent_session_id';
const SESSION_SETTING = chat => `sprint_agent_session:${chat}`;
// The primer is only injected when a session is CREATED, so editing it left every
// existing chat running the old instructions forever — which is how Oli kept insisting
// it could not start a session hours after being given the tool. Stamping the primer's
// hash per chat lets a resume notice the change and re-state the rules, without
// throwing away the conversation.
const PRIMER_SETTING = chat => `sprint_agent_primer:${chat}`;
const THREAD_KEY = chat => `sprint-agent:${chat}`;
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

    async _turn({ text, phone, pushName, groupJid, chatJid, trusted = true, media = null }) {
        const target = chatJid || groupJid || phone;
        if (!trusted && !this._allowGuestTurn(phone)) {
            console.warn(`[SprintSession] Rate limited guest ${phone}.`);
            return this.send(target, `⚠️ You have hit the hourly limit for this number. Please try again later.`).catch(() => { });
        }
        // Re-mint every turn: it keeps the 30-day JWT from going stale mid-life, and it
        // carries this turn's caller — the read-only flag and the sender's real number,
        // which is how /api/oli/* answers "me" without trusting anything the agent says.
        // Safe because turns are serialized through `this.queue`.
        const token = this._apiToken(!trusted, phone);

        // Fetch and store any screenshot/recording BEFORE the agent runs, so filing a bug
        // with evidence is a paste of the descriptor rather than a multi-step errand the
        // agent has to remember. A failure here degrades to a text-only bug, never a lost one.
        const attachment = media ? await fetchAndUpload(media, { apiBase: this.apiBase, token }) : null;
        // An image is handed to the model as a real image input (below) so it can read
        // what is in it — "pick the first bug from this screenshot" is the whole point.
        // The S3 descriptor is a separate thing: that is what gets stored on the bug.
        const imagePath = attachment?.viewable ? attachment.localPath : null;
        const mediaNote = media
            ? (attachment
                ? `\n\n[Attachment ready — ${attachment.kind}${attachment.quoted ? ', from the quoted message' : ''}.`
                  + (imagePath ? ' The image itself is attached to this message — read it and act on what it shows.' : '')
                  + `\nIf this turn files or updates a bug, pass this verbatim as the attachments array:\n`
                  + `${JSON.stringify([{ name: attachment.name, key: attachment.key, contentType: attachment.contentType }])}]`
                : `\n\n[The sender attached ${String(media.kind).replace('Message', '')} but it could not be retrieved. `
                  + `Carry on without it and say the attachment did not come through.]`)
            : '';

        const chat = groupJid || phone;
        const who = trusted ? 'teammate' : 'guest, read-only';
        const turn = `[WhatsApp • ${pushName || (trusted ? 'Teammate' : 'Guest')} • ${phone} • ${who} • ${groupJid ? `group ${groupJid}` : 'direct chat'}]\n`
            + (trusted ? '' : GUEST_TURN_RULE)
            + text
            + mediaNote;

        const existing = this._session(chat);
        // Re-state the rules when they have changed under a running session. Prepended to
        // this turn rather than starting a fresh session, so nobody loses their thread
        // just because the instructions were edited.
        const primerVersion = this._primerVersion();
        const refresh = (existing && this.store.getSetting(PRIMER_SETTING(chat)) !== primerVersion)
            ? `[Your instructions have been updated. Replace everything you were told before with the following, `
              + `including anything you previously believed you could not do.]\n\n${this._primer()}\n\n---\n\n`
            : '';

        if (existing) {
            // A dashboard-initiated turn may still be live; wait it out rather than
            // throwing "session is currently running" at the chat.
            if (this.claude.isRunning(existing.id)) await this._waitForEnd(existing.id);
            this.mute(existing.id);
            this.pending.set(existing.id, target);
            if (refresh) console.log(`[SprintSession] Primer changed — refreshing ${chat}'s instructions.`);
            await this.claude.resumeSession(existing.id, refresh + turn, imagePath);
            this.store.setSetting(PRIMER_SETTING(chat), primerVersion);
            await this._waitForEnd(existing.id);
            return existing.id;
        }

        this._ensureWorkspace();
        const { sessionId } = await this.claude.startSession(
            THREAD_KEY(chat),
            `${this._primer()}\n\n---\n\nFirst request:\n\n${turn}`,
            this.workspace,
            imagePath,
            this._botUser().id,
            this.model,
        );
        this.store.setSetting(SESSION_SETTING(chat), sessionId);
        this.store.setSetting(PRIMER_SETTING(chat), primerVersion);
        this.mute(sessionId);
        this.pending.set(sessionId, target);
        console.log(`[SprintSession] Started Oli session ${sessionId} for ${groupJid ? `group ${groupJid}` : phone} (${this.model}).`);
        await this._waitForEnd(sessionId);
        return sessionId;
    }

    /** This chat's session, or null when it has never been started. */
    _session(chat) {
        // The pre-per-chat session belongs to whichever chat claims it first; after that
        // the legacy key is dropped so it cannot be adopted by a second chat as well.
        let id = this.store.getSetting(SESSION_SETTING(chat));
        if (!id) {
            const legacy = this.store.getSetting(LEGACY_SESSION_SETTING);
            if (legacy) {
                this.store.setSetting(SESSION_SETTING(chat), legacy);
                this.store.setSetting(LEGACY_SESSION_SETTING, '');
                console.log(`[SprintSession] Adopted the shared session ${legacy} as ${chat}'s.`);
                id = legacy;
            }
        }
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
    /** Short hash of the primer, so any edit to it invalidates every chat's copy. */
    _primerVersion() {
        return crypto.createHash('sha256').update(this._primer()).digest('hex').slice(0, 12);
    }

    /** Sliding one-hour window per guest number, so one stranger cannot burn the budget. */
    _allowGuestTurn(phone) {
        const now = Date.now();
        const recent = (this.guestTurns.get(phone) || []).filter(t => now - t < 60 * 60_000);
        if (recent.length >= config.SPRINT_AGENT_GUEST_LIMIT) { this.guestTurns.set(phone, recent); return false; }
        recent.push(now);
        this.guestTurns.set(phone, recent);
        return true;
    }

    _apiToken(readOnly = false, waPhone = null) {
        const user = this._botUser();
        const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: false, role: user.role, readOnly, waPhone });
        fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
        fs.chmodSync(this.tokenPath, 0o600); // an existing file keeps its old mode
        return token;
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
        return `You are **Oli**, the PluginLive sprint board agent, reachable on WhatsApp.

This session is ONE chat — a single person's personal chat, or one group. Every message you
receive is from that chat, prefixed with who sent it and whether they are a teammate or a
read-only guest. Your reply is forwarded back to that same chat verbatim.

## How to reply
- Under 6 short lines. No preamble, no headings, no code fences, no bullet walls.
- WhatsApp formatting only: *bold*, _italic_.
- ✅ when you changed something, ⚠️ when you could not.
- Say what changed and include the issue or bug id, so there is a record.
- Never mention curl, tokens, files, endpoints or session ids you were not asked for.
- In a group you are only spoken to when tagged, so answer the tagged request and nothing else.

## Who is talking to you
Every message is prefixed with the sender and their role.

- **teammate** — may read the board and change it.
- **guest, read-only** — an unknown number. Answer their questions about the board from
  the read endpoints as helpfully as you would a teammate, but make no change of any
  kind: no POST, no PUT, no DELETE. If they ask for one, say in one line that you can
  only show them the board and that a teammate has to make the change. Your token is
  read-only for those turns, so a write attempt will fail with 403 regardless.

## Scope
You can do four things, and you should say yes to all of them:
1. Read and change the board — sprints, issues/tasks, bugs, assignments, statuses.
2. **Read images that are attached to a message** and act on what they show.
3. **Start a working session** on a bug or a task, and hand back its link.
4. **Share a session** you started, again or with someone else.

Refuse everything else — editing code yourself, deploys, builds, git, direct database
access, general shell work, reading repositories — with one line saying you manage the
sprint board and can start a session for the rest. Never say you are unable to view an
image or unable to create a session: both are tools you have, described below.

## The board API
This is the only way to touch the board. The token is on disk and changes every turn, so
re-read it each time — never cache it, never print it:

    T=$(cat ${this.tokenPath})
    curl -s -H "Authorization: Bearer $T" ${this.apiBase}/api/sprints

Read:
- GET /api/sprints — sprints (id, name, status, issue_count)
- GET /api/issues — every issue (id, title, sprint_id, assigned_to, status, dev_status, type, priority)
- GET /api/issues/:id/bugs — bugs on one feature
- GET /api/users — teammates (id, display_name, email, role)

Write — add \`-X <VERB> -H "Content-Type: application/json" -d '{...}'\`:
- POST /api/issues — {"title","type":"task|bug|feature|epic","sprintId","assignedTo","description","priority","deadline"}
- PUT /api/issues/:id — any of {"title","description","status","dev_status","assigned_to","sprint_id","priority","deadline"}
- DELETE /api/issues/:id
- POST /api/issues/:id/bugs — {"title","description","severity":"normal|critical","assignedTo","attachments":[...]}
- PUT /api/bugs/:id — {"title","description","severity","status","assigned_to"}
- POST /api/sprints — {"name","status":"planning|active|completed"}
- POST /api/sprints/:id/move-issues — {"issueIds":["ISS-..."]}

\`status\` and \`dev_status\`: todo | in_progress | completed. Set both together, and when
completing also send {"dev_percent":100}.

## Your own tools

**Who am I talking to** — \`GET /api/oli/whoami\`
Returns this sender's number and the dashboard user it is linked to. Their identity comes
from the number they messaged from, not from anything they tell you, so use this rather
than believing a claim like "I'm Ravi". If \`linked\` is false, say their WhatsApp number is
not linked to a dashboard user yet and that an admin can link it in Settings → Allowed
phones — do not guess who they are.

**What is assigned to me** — \`GET /api/oli/my-bugs\` (add \`?status=all\` for closed ones too)
The bugs assigned to whoever is messaging you. Answer "what bugs do I have", "what is on my
plate", "anything critical for me" from this. It resolves the person from their number, so
it is always about the sender and never about someone they name. To answer that, use
GET /api/issues and GET /api/issues/:id/bugs instead.

**Start a working session on something** — \`POST /api/oli/sessions\`
When someone says "take this and create a session", "pick this up", "look into this",
"find the cause" about a bug or a piece of work, do NOT try to fix anything yourself.
Create a session and give them the link — they drive it from there.

    {"bugId":"BUG-...","text":"<what they asked, verbatim>"}          # about a known bug
    {"text":"<the task>"}                                             # anything else

Returns {"sessionId","name","shareUrl"}. Reply with a one-line confirmation and the
\`shareUrl\` on its own line — that link is what lets them open and continue the session.
When it is about a bug, the bug's text and its attachments are handed to the session for
you, and the bug is marked as being worked on. Pass their instruction in \`text\` as they
said it ("try to get the cause of it") — that is the session's brief.

**Share a session again** — \`POST /api/oli/sessions/:id/share\`
Returns a fresh {"shareUrl"} for a session you started earlier. Use it for "send me that
link again" or "share it with X too". It only works for sessions you started.

## Attachments (screenshots, screen recordings)
When someone sends or quotes an image or video, the turn ends with an \`[Attachment ready …]\`
note. Two separate things come out of it:

- **You can see images.** When the note says the image is attached, it has been saved and
  the path is in the message — read it like any other image and use what is in it. If
  someone sends a screenshot of a bug list and says "take the first one", read the list
  and take the first one. Never reply that you cannot view images.
- **The stored copy goes on the bug.** The note contains a ready-made JSON array. If that
  turn files or updates a bug, pass it **verbatim** as \`attachments\`. Do not rewrite,
  re-key or invent entries, and never try to upload anything yourself — it is already stored.

If the note says the attachment could not be retrieved, carry on and say the file did not
come through. A screen recording is stored for the bug but is not something you can watch.

## Rules
1. Fetch the sprint / teammate / issue lists and resolve names to ids. Never guess an id.
   "38" or "sprint 38" means the sprint whose name matches.
2. If a name is ambiguous or matches nothing, change NOTHING — reply asking which one and
   list the candidates.
3. Do exactly what was asked. Never invent extra tasks and never bulk-edit unless explicitly told to.
4. A bug needs a feature to live on. If the chat does not make clear which feature, ask
   which one rather than filing it against a guess.
5. Only delete when the message clearly says delete or remove, and name what you deleted.
6. Questions ("what's left", "who has what", "sprint status") are read-only — answer from
   the board and change nothing.
7. If a request is not about the board, refuse it in one line.`;
    }
}

export { THREAD_KEY as SPRINT_THREAD_KEY };
