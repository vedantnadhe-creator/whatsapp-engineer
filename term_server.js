// ---------------------------------------------------------------------------
// term_server.js — interactive web terminal (the /sessions/v2 workspace)
//
// LEGITIMATE, human-driven path: a real person types into a real interactive
// `claude` REPL in a PTY, streamed to xterm.js. No `--print`, so it draws from
// the Claude subscription pool, NOT the Agent SDK credit pool.
//
// PERSISTENCE: PTYs live in a server-side registry keyed by session id and
// SURVIVE WebSocket disconnects. A reconnecting browser RE-ATTACHES to the same
// running process (and replays its scrollback) instead of spawning a new one.
// This is what stops the "session restarts / re-asks trust on every reconnect"
// problem — the process keeps running; only the viewer comes and goes.
//
// Session bridge: a terminal session's id IS the Claude session UUID (--session-id),
// so resume/fork map onto `claude --resume <uuid>` / `--fork-session`.
//
// Protocol (JSON frames over WS at /term):
//   client → server: {type:'start', cols, rows, model?, sessionId?, resume?, fork?, name?, cwd?}
//                     {type:'attach', terminalId, cols, rows}
//                     {type:'input', data} | {type:'resize', cols, rows} | {type:'ping'}
//   server → client: {type:'ready'} | {type:'started', sessionId, terminalId, cwd, model, mode}
//                     {type:'attached', terminalId} | {type:'forked', sessionId, terminalId, parentId}
//                     {type:'output', data} | {type:'exit', code} | {type:'error', message} | {type:'pong'}
// ---------------------------------------------------------------------------

import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from './config.js';
import { verifyJwt } from './auth.js';
import { createExtractor } from './term_extract.js';

// Claude Code persists per-folder trust in ~/.claude.json. We pre-accept it for
// any working dir before spawning, so the interactive "Do you trust this folder?"
// dialog never appears. That dialog renders in the live region the chat view
// strips, so an untrusted dir would otherwise look permanently stuck.
const CLAUDE_CONFIG = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');

const ensureTrusted = (dir) => {
    try {
        const cfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'));
        cfg.projects = cfg.projects || {};
        const proj = cfg.projects[dir] || (cfg.projects[dir] = {});
        if (proj.hasTrustDialogAccepted === true && proj.hasCompletedProjectOnboarding === true) return;
        proj.hasTrustDialogAccepted = true;
        proj.hasCompletedProjectOnboarding = true;
        if (proj.projectOnboardingSeenCount == null) proj.projectOnboardingSeenCount = 1;
        fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(cfg, null, 2));
    } catch (_) { /* best-effort: if the config can't be written the dialog still shows */ }
};

const BUFFER_CAP = 256 * 1024;       // scrollback replayed to a (re)attaching client
const IDLE_KILL_MS = 30 * 60 * 1000; // kill a PTY with no viewers after 30 min
const CHAT_DEBOUNCE_MS = 180;        // settle window before re-parsing the screen into chat
const WORK_GRACE_MS = 4000;          // keep "working" latched across brief inter-tool / pre-stop-hook spinner gaps

// Auto-/compact: the gsd statusline hook writes a per-session bridge file
// (os.tmpdir()/claude-ctx-<session-uuid>.json) holding the live context window
// state — { remaining_percentage, used_pct, … }. We read it (no terminal
// scraping) and, when a turn ENDS with little context left, inject `/compact`
// into the PTY ourselves so long sessions don't hit Claude's hard limit
// mid-turn. Firing only between turns (at turn-done, working=false) means we
// never interrupt a running turn. `remaining_percentage` is the raw remaining %
// (Claude's own auto-compact is ~20% remaining / 80% used) — we trigger a touch
// earlier so it's our controlled compaction, in the chat flow.
const CTX_BRIDGE_DIR = os.tmpdir();
const CTX_COMPACT_REMAINING = 25;    // auto-/compact when ≤ this much context remains (raw %)
const CTX_REARM_REMAINING = 50;      // only re-arm after a compaction frees space back above this

const readCtxRemaining = (claudeId) => {
    if (!claudeId || claudeId.startsWith('pending-')) return null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(CTX_BRIDGE_DIR, `claude-ctx-${claudeId}.json`), 'utf8'));
        return typeof j.remaining_percentage === 'number' ? j.remaining_percentage : null;
    } catch (_) { return null; }
};

// Clean chat from the session transcript (the source of truth) instead of the
// scraped TUI screen. The interactive TUI REFLOWS rich content to the terminal
// width — markdown tables in particular get wrapped/box-drawn and arrive as
// mangled pipe-soup that remark-gfm can't parse. The JSONL transcript holds the
// model's ORIGINAL markdown (clean `| h |` / `|---|` tables, fenced code, etc.).
// We use it for the settled view; the live TUI scrape still drives the in-flight
// turn (the transcript is only written as each message completes).
const toolLabel = (b) => {
    const inp = b.input || {};
    const arg = inp.file_path || inp.path || inp.pattern || inp.command || inp.description
        || inp.query || inp.skill || inp.subject || inp.url || inp.taskId || '';
    const short = String(arg).split('\n')[0].slice(0, 60);
    return short ? `${b.name}(${short})` : b.name;
};
const userText = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    if (content.some((b) => b.type === 'tool_result')) return ''; // tool output, NOT a user turn
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};
const readCleanMessages = (store, entry) => {
    if (!store?.transcriptPath || !entry?.claudeId || entry.claudeId.startsWith('pending-')) return null;
    let file;
    try { file = store.transcriptPath(entry.claudeId, entry.cwd); } catch (_) { return null; }
    if (!file || !fs.existsSync(file)) return null;
    const out = [];
    try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            if (o.isSidechain) continue;                       // skip subagent internals
            if (o.type === 'user') {
                const t = userText(o.message?.content);
                if (t && t.trim() && !t.startsWith('<')) out.push({ role: 'user', content: t.trim(), tool: false });
            } else if (o.type === 'assistant') {
                const c = o.message?.content;
                if (typeof c === 'string') { if (c.trim()) out.push({ role: 'assistant', content: c, tool: false }); continue; }
                if (!Array.isArray(c)) continue;
                for (const b of c) {
                    if (b.type === 'text' && b.text && b.text.trim()) out.push({ role: 'assistant', content: b.text, tool: false });
                    else if (b.type === 'tool_use') out.push({ role: 'assistant', content: toolLabel(b), tool: true });
                }
            }
        }
    } catch (_) { return null; }
    return out.length ? out : null;
};

// Role-driven session persona (mirrors V1's claude_manager): designers run in the
// designs repo (its own CLAUDE.md), developers use the default CLAUDE.md, testers
// run in the code repo with a QA persona appended (+ read-only gating if they lack
// edit access). Copied here so V1's module is left untouched.
const EDIT_TOOLS = 'Edit,Write,NotebookEdit,MultiEdit';
const TESTER_PROMPT = `[ROLE: TESTER] You are operating as a QA tester, not a developer. Your job is to verify the change under test — NOT to build features.
SOURCE OF TRUTH — derive expected behavior in THIS strict priority order, do NOT jump to reading code first:
  1. PRDs — the product requirements are the primary spec. If the tester's instruction names a PRD or links one, use it.
  2. Knowledge Base — the pluginlive-kb GitHub repo cloned at /home/ubuntu/pluginlive-kb. Search it, then read the relevant doc.
Work AUTONOMOUSLY: do NOT pause to ask for a PRD, acceptance criteria, scope, or permission. Pull expected behavior from the PRD/KB and the tester's instruction, then start testing. Focus on: understanding what changed and the expected behavior; writing structured test cases (happy path, edge, negative); reproducing reported behavior; running read-only checks and reporting findings (passed/failed, exact repro steps, severity).
REPORTING — the bug report must contain ONLY: WHAT the bug is (observable wrong behavior, repro steps, severity) and WHY it happens (the root cause). You MAY read code (read-only) to pin down the root cause, but you must NOT output any fix: no code suggestions, diffs, patches, or corrected snippets. Stop at WHAT + WHY — fixing is the developer's job.`;

// Map a user's role → { mode tag, working dir, extra claude args }. `roleMode` is
// stored on the session so the board can tag designer/tester sessions.
function roleConfig(user, store, cwd) {
    const role = (user && user.role) || 'developer';
    const roleMode = role === 'designer' ? 'design' : role === 'tester' ? 'tester' : 'developer';
    const defaultBase = roleMode === 'design' && config.DESIGNS_DIR ? config.DESIGNS_DIR : config.DEFAULT_WORKING_DIR;
    const root = config.DEFAULT_WORKING_DIR;
    // Honour a resume/fork cwd that lives under the workspace root; new sessions
    // fall back to the role's default dir (designers → designs repo).
    const workingDir = (cwd && String(cwd).startsWith(root)) ? cwd : defaultBase;
    const extraArgs = [];
    if (roleMode === 'tester') {
        let canEdit = true;
        try { canEdit = store?.getUserById?.(user.id)?.can_edit !== 0; } catch (_) {}
        const editLine = canEdit
            ? 'You MAY edit code and test files to add or run tests.'
            : 'READ-ONLY: you do NOT have code-edit access. Produce test cases, run read-only checks, and report findings. File-editing tools are disabled.';
        extraArgs.push('--append-system-prompt', `${TESTER_PROMPT}\n${editLine}`);
        if (!canEdit) extraArgs.push(`--disallowedTools=${EDIT_TOOLS}`);
    }
    return { roleMode, workingDir, extraArgs };
}

function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

export function attachTerminalServer(store) {
    const wss = new WebSocketServer({ noServer: true });

    // key (claude session uuid) → { proc, claudeId, rowId, cwd, buffer, clients:Set<ws>, idleTimer }
    const terminals = new Map();

    const appendBuffer = (entry, data) => {
        entry.buffer += data;
        if (entry.buffer.length > BUFFER_CAP) entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_CAP);
    };

    // Re-parse the headless screen into a clean conversation and push it to viewers.
    // Runs alongside the raw `output` stream — xterm clients ignore `chat`, chat
    // clients ignore `output`, so neither view interferes with the other.
    const broadcastChat = (entry) => {
        if (!entry?.extractor) return;
        let snapshot;
        try { snapshot = entry.extractor.extract(); } catch (_) { return; }

        // Hysteresis: the spinner briefly vanishes between tool calls within one
        // turn. Treat the turn as still working until the spinner has been gone for
        // WORK_GRACE_MS, so the box stays "Working…" across the whole turn and only
        // flips to "Done" when the chat truly stops.
        const now = Date.now();
        if (snapshot.working) { entry.lastSpinnerTs = now; if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; } }
        const sinceSpinner = now - (entry.lastSpinnerTs || 0);
        const working = snapshot.working || sinceSpinner < WORK_GRACE_MS;
        // Still "working" only because of the grace window → schedule the flip to done.
        if (!snapshot.working && working && !entry.graceTimer) {
            entry.graceTimer = setTimeout(() => { entry.graceTimer = null; broadcastChat(entry); }, WORK_GRACE_MS - sinceSpinner + 50);
        }

        // Authoritative "turn done" — fires EXACTLY ONCE per turn, in the backend.
        // A turn is one continuous `working` span (the grace window above stitches
        // the brief inter-tool / pre-stop-hook spinner gaps into a single span). The
        // single composite true→false edge is the turn end; we pulse `turnDone` on
        // that one frame only. The client beeps on this pulse instead of re-deriving
        // "done" from the `working` boolean — so the chime can't fire per-tool
        // (the "buzzing 11 times" bug). `entry.wasWorking === true` guards the
        // initial attach edge (undefined/false → false never pulses).
        const turnDone = entry.wasWorking === true && working === false;

        // Reflect real activity in the session status: 'running' while working,
        // 'stopped' when done — also bumps updated_at so it floats to the top.
        if (store && entry.rowId && entry.wasWorking !== working) {
            try { store.updateSession(entry.rowId, { status: working ? 'running' : 'stopped' }); } catch (_) {}
        }
        entry.wasWorking = working;
        // Settled turn → render the clean transcript (correct tables/code/markdown);
        // mid-turn → the live TUI scrape (transcript isn't written until a message
        // completes). Falls back to the scrape if the transcript can't be read.
        let messages = snapshot.messages;
        if (!working) { const clean = readCleanMessages(store, entry); if (clean) messages = clean; }
        const payload = JSON.stringify({ type: 'chat', messages, text: snapshot.text, working, turnDone });
        for (const c of entry.clients) { if (c.readyState === 1) c.send(payload); }

        // A turn just ended → if context is nearly spent, auto-compact before the
        // next message. Done here (working=false) so we never cut into a live turn.
        if (turnDone) maybeAutoCompact(entry);
    };

    // Inject `/compact` into the PTY when the session is low on context. Re-arms
    // only after compaction frees space, so it fires once per fill cycle — not on
    // every turn while sitting near the limit.
    const maybeAutoCompact = (entry) => {
        if (!entry?.proc) return;
        const rem = readCtxRemaining(entry.claudeId);
        if (rem == null) return;
        if (rem >= CTX_REARM_REMAINING) entry.autoCompacted = false; // freed up → arm again
        if (rem > CTX_COMPACT_REMAINING || entry.autoCompacted) return;
        entry.autoCompacted = true;
        try {
            entry.proc.write('/compact');
            setTimeout(() => { try { entry.proc.write('\r'); } catch (_) {} }, 80);
        } catch (_) { return; }
        const notice = JSON.stringify({ type: 'notice', level: 'info', message: `Context ~${100 - rem}% full — auto-compacting to free space…` });
        for (const c of entry.clients) { if (c.readyState === 1) c.send(notice); }
    };

    const scheduleChat = (entry) => {
        if (!entry?.extractor) return;
        if (entry.chatTimer) return; // a parse is already pending within the debounce window
        entry.chatTimer = setTimeout(() => { entry.chatTimer = null; broadcastChat(entry); }, CHAT_DEBOUNCE_MS);
    };

    const finalize = (entry) => {
        if (!entry || !store || !entry.rowId) return;
        try { store.updateSession(entry.rowId, { status: 'stopped' }); } catch (_) {}
        try { store.syncTranscript(entry.rowId, entry.cwd, entry.claudeId); } catch (_) {}
    };

    const detach = (ws) => {
        const entry = ws._term;
        ws._term = null;
        if (!entry) return;
        entry.clients.delete(ws);
        // Keep the PTY alive with no viewers, but GC after a long idle window.
        if (entry.clients.size === 0 && !entry.idleTimer) {
            entry.idleTimer = setTimeout(() => {
                if (entry.chatTimer) { clearTimeout(entry.chatTimer); entry.chatTimer = null; }
                if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
                try { entry.extractor?.dispose(); } catch (_) {}
                try { entry.proc?.kill(); } catch (_) {}
                terminals.delete(entry.claudeId);
            }, IDLE_KILL_MS);
        }
    };

    const attachClient = (ws, entry, cols, rows) => {
        // leave any previous terminal first
        if (ws._term && ws._term !== entry) detach(ws);
        ws._term = entry;
        entry.clients.add(ws);
        if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
        // Replay scrollback so the fresh xterm shows current state.
        if (entry.buffer && ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: entry.buffer }));
        if (cols && rows) {
            try { entry.proc?.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch (_) {}
            try { entry.extractor?.resize(cols, rows); } catch (_) {}
        }
        // Hand the (re)attaching client the current clean conversation immediately.
        try {
            const snap = entry.extractor?.extract();
            if (snap && ws.readyState === 1) {
                let messages = snap.messages;
                if (!snap.working) { const clean = readCleanMessages(store, entry); if (clean) messages = clean; }
                ws.send(JSON.stringify({ type: 'chat', messages, text: snap.text, working: snap.working }));
            }
        } catch (_) {}
    };

    const spawnTerminal = (user, { cols = 80, rows = 24, model, sessionId, resume, fork, name, cwd } = {}) => {
        const bin = config.CLAUDE_BIN;
        // Role-driven dir + persona (designer/developer/tester).
        const { roleMode, workingDir, extraArgs } = roleConfig(user, store, cwd);

        // Default to no permission prompts: these sessions are driven from the
        // chat view, where tool-permission dialogs would render in the stripped
        // live region (invisible) and stall the session. (Claude refuses this
        // flag as root; the service runs as the `ubuntu` user, so it's fine.)
        const args = ['--dangerously-skip-permissions', ...extraArgs];
        let claudeId, rowId, mode, forkParent = null;
        if (resume && sessionId) {
            args.push('--resume', sessionId);
            claudeId = sessionId;
            if (fork) {
                args.push('--fork-session');
                forkParent = sessionId;
                claudeId = null; rowId = null; mode = 'fork';
            } else {
                const existing = store?.getSession?.(sessionId) || store?.getSessionByClaudeId?.(sessionId);
                rowId = existing ? existing.id : sessionId;
                mode = 'resume';
            }
        } else {
            claudeId = sessionId || crypto.randomUUID();
            rowId = claudeId;
            args.push('--session-id', claudeId);
            mode = 'new';
        }
        if (model && model !== 'default') args.push('--model', model);

        ensureTrusted(workingDir); // pre-accept folder trust so no dialog blocks the session

        const proc = pty.spawn(bin, args, {
            name: 'xterm-256color',
            cols: Math.max(20, cols | 0),
            rows: Math.max(5, rows | 0),
            cwd: workingDir,
            env: { ...process.env, TERM: 'xterm-256color' },
        });

        // Headless emulator mirror — same bytes as the PTY, read back as clean text.
        const extractor = createExtractor({ cols, rows });

        // For a non-fork session we know the key up-front; forks get keyed once detected.
        const entry = { proc, extractor, chatTimer: null, claudeId: claudeId || `pending-${crypto.randomUUID()}`, rowId, cwd: workingDir, buffer: '', clients: new Set(), idleTimer: null, mode };
        terminals.set(entry.claudeId, entry);

        // Register / refresh the DB row.
        if (store && rowId && mode !== 'fork') {
            if (mode === 'new') {
                try { store.createTerminalSession(rowId, user.id, name || 'Terminal session', workingDir, model || 'claude-opus-4-8'); } catch (_) {}
                try { store.updateSession(rowId, { mode: roleMode }); } catch (_) {} // tag designer/tester sessions
            } else if (mode === 'resume') {
                if (!store.getSession(rowId)) { try { store.createTerminalSession(rowId, user.id, name || 'Terminal session', workingDir, model || 'claude-opus-4-8'); } catch (_) {} }
                try { store.updateSession(rowId, { status: 'running' }); } catch (_) {}
            }
        }

        // Fork: poll for the freshly-written uuid, then re-key + register.
        if (forkParent) {
            const since = Date.now();
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                const found = store?.detectNewSession?.(workingDir, since - 1500, forkParent);
                if (found) {
                    clearInterval(timer);
                    terminals.delete(entry.claudeId);
                    entry.claudeId = found; entry.rowId = found;
                    terminals.set(found, entry);
                    try { store.createTerminalSession(found, user.id, name || 'Fork', workingDir, model || 'claude-opus-4-8', forkParent); } catch (_) {}
                    try { store.updateSession(found, { mode: roleMode }); } catch (_) {}
                    for (const c of entry.clients) { if (c.readyState === 1) c.send(JSON.stringify({ type: 'forked', sessionId: found, terminalId: found, parentId: forkParent })); }
                } else if (tries > 20) { clearInterval(timer); }
            }, 500);
        }

        proc.on('data', (data) => {
            appendBuffer(entry, data);
            try { entry.extractor?.feed(data); } catch (_) {}
            for (const c of entry.clients) { if (c.readyState === 1) c.send(JSON.stringify({ type: 'output', data })); }
            scheduleChat(entry);
        });
        proc.on('exit', (code) => {
            const exitCode = typeof code === 'number' ? code : 0;
            if (entry.chatTimer) { clearTimeout(entry.chatTimer); entry.chatTimer = null; }
                if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
            try { broadcastChat(entry); } catch (_) {}      // final clean snapshot
            try { entry.extractor?.dispose(); } catch (_) {}
            finalize(entry);
            for (const c of entry.clients) { if (c.readyState === 1) c.send(JSON.stringify({ type: 'exit', code: exitCode })); }
            terminals.delete(entry.claudeId);
        });

        return entry;
    };

    wss.on('connection', (ws, req) => {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.wa_token || (req.headers.authorization || '').replace('Bearer ', '');
        const user = token ? verifyJwt(token) : null;
        if (!user) {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); } catch (_) {}
            return ws.close();
        }
        ws._term = null;

        ws.on('message', (raw) => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
            switch (msg.type) {
                case 'attach': {
                    // Reconnect: re-attach to the live PTY if it's still running.
                    const entry = msg.terminalId && terminals.get(msg.terminalId);
                    if (entry && entry.proc) {
                        attachClient(ws, entry, msg.cols, msg.rows);
                        try { ws.send(JSON.stringify({ type: 'attached', terminalId: entry.claudeId })); } catch (_) {}
                    } else {
                        // PTY gone — fall back to resuming that session id.
                        const e2 = spawnTerminal(user, { cols: msg.cols, rows: msg.rows, sessionId: msg.terminalId, resume: true });
                        attachClient(ws, e2, msg.cols, msg.rows);
                        try { ws.send(JSON.stringify({ type: 'started', sessionId: e2.rowId, terminalId: e2.claudeId, cwd: e2.cwd, mode: 'resume' })); } catch (_) {}
                    }
                    break;
                }
                case 'start': {
                    // If resuming a session that already has a live PTY, just attach.
                    if (msg.resume && !msg.fork && msg.sessionId && terminals.has(msg.sessionId)) {
                        const entry = terminals.get(msg.sessionId);
                        attachClient(ws, entry, msg.cols, msg.rows);
                        try { ws.send(JSON.stringify({ type: 'started', sessionId: entry.rowId, terminalId: entry.claudeId, cwd: entry.cwd, mode: 'resume' })); } catch (_) {}
                        break;
                    }
                    const entry = spawnTerminal(user, msg);
                    attachClient(ws, entry, msg.cols, msg.rows);
                    try { ws.send(JSON.stringify({ type: 'started', sessionId: entry.rowId, terminalId: entry.claudeId, cwd: entry.cwd, model: msg.model || 'default', mode: entry.mode })); } catch (_) {}
                    break;
                }
                case 'input':
                    try { ws._term?.proc?.write(msg.data); } catch (_) {}
                    break;
                case 'resize':
                    try { ws._term?.proc?.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0)); } catch (_) {}
                    try { ws._term?.extractor?.resize(msg.cols, msg.rows); } catch (_) {}
                    break;
                case 'ping':
                    try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
                    break;
                default:
                    break;
            }
        });

        ws.on('close', () => detach(ws));
        ws.on('error', () => detach(ws));

        try { ws.send(JSON.stringify({ type: 'ready', user: user.displayName || user.email || 'you' })); } catch (_) {}
    });

    console.log('[Terminal] 🖥️  Interactive terminal WS on /term (persistent PTYs)');
    return wss;
}
