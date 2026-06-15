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
        const payload = JSON.stringify({ type: 'chat', messages: snapshot.messages, text: snapshot.text });
        for (const c of entry.clients) { if (c.readyState === 1) c.send(payload); }
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
            if (snap && ws.readyState === 1) ws.send(JSON.stringify({ type: 'chat', messages: snap.messages, text: snap.text }));
        } catch (_) {}
    };

    const spawnTerminal = (user, { cols = 80, rows = 24, model, sessionId, resume, fork, name, cwd } = {}) => {
        const bin = config.CLAUDE_BIN;
        const base = config.DEFAULT_WORKING_DIR;
        const workingDir = (cwd && String(cwd).startsWith(base)) ? cwd : base;

        // Default to no permission prompts: these sessions are driven from the
        // chat view, where tool-permission dialogs would render in the stripped
        // live region (invisible) and stall the session. (Claude refuses this
        // flag as root; the service runs as the `ubuntu` user, so it's fine.)
        const args = ['--dangerously-skip-permissions'];
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
