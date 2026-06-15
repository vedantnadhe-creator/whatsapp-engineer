// ---------------------------------------------------------------------------
// term_server.js — interactive web terminal (the /sessions/v2 workspace)
//
// LEGITIMATE, human-driven path: a real person types into a real interactive
// `claude` REPL in a PTY, streamed to xterm.js. No `--print`, so it draws from
// the Claude subscription pool, NOT the Agent SDK credit pool.
//
// Session bridge: each terminal session's id IS the Claude session UUID, set via
// `--session-id`. That makes the whole lifecycle map onto Claude Code's own JSONL
// store and native flags:
//   new    → claude --session-id <uuid>
//   resume → claude --resume <uuid>
//   fork   → claude --resume <uuid> --fork-session   (Claude writes a new uuid)
// All three stay interactive (subscription-billed). OliBot just registers the
// uuid in its sessions table and indexes the JSONL for history/search/share.
//
// Protocol (JSON frames over WS at /term):
//   client → server: {type:'start', cols, rows, model?, sessionId?, resume?, fork?, name?, cwd?}
//                     {type:'input', data} | {type:'resize', cols, rows}
//   server → client: {type:'ready'} | {type:'started', sessionId, cwd, model, mode}
//                     {type:'output', data} | {type:'exit', code} | {type:'error', message}
// ---------------------------------------------------------------------------

import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import config from './config.js';
import { verifyJwt } from './auth.js';

function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// store is the SessionStore — used to register terminal sessions + index transcripts.
export function attachTerminalServer(store) {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws, req) => {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.wa_token || (req.headers.authorization || '').replace('Bearer ', '');
        const user = token ? verifyJwt(token) : null;
        if (!user) {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); } catch (_) {}
            return ws.close();
        }

        let proc = null;
        let claudeId = null;  // Claude session UUID (transcript filename, --resume arg)
        let rowId = null;     // OliBot sessions-table row id (may differ for agent sessions)
        let currentDir = config.DEFAULT_WORKING_DIR;
        let forkPending = null; // { parentId, sinceMs } when resuming with --fork-session

        const kill = () => { try { proc?.kill(); } catch (_) {} proc = null; };

        const finalize = () => {
            if (!rowId || !store) return;
            try { store.updateSession(rowId, { status: 'stopped' }); } catch (_) {}
            try { store.syncTranscript(rowId, currentDir, claudeId); } catch (_) {}
        };

        const spawnTerm = ({ cols = 80, rows = 24, model, sessionId, resume, fork, name, cwd } = {}) => {
            if (proc) { kill(); }

            const bin = config.CLAUDE_BIN;
            const base = config.DEFAULT_WORKING_DIR;
            currentDir = (cwd && String(cwd).startsWith(base)) ? cwd : base;

            const args = [];
            let mode;
            forkPending = null;
            if (resume && sessionId) {
                // sessionId is the Claude session UUID to resume.
                args.push('--resume', sessionId);
                claudeId = sessionId;
                if (fork) {
                    args.push('--fork-session');
                    forkPending = { parentId: sessionId, sinceMs: Date.now() };
                    claudeId = null; rowId = null; // discovered post-spawn
                    mode = 'fork';
                } else {
                    // Reuse the existing row (terminal row id == uuid; agent row id == WA-xxx).
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

            try {
                proc = pty.spawn(bin, args, {
                    name: 'xterm-256color',
                    cols: Math.max(20, cols | 0),
                    rows: Math.max(5, rows | 0),
                    cwd: currentDir,
                    env: { ...process.env, TERM: 'xterm-256color' },
                });
            } catch (err) {
                try { ws.send(JSON.stringify({ type: 'error', message: `Spawn failed: ${err.message}` })); } catch (_) {}
                return;
            }

            // Register/refresh the session row so it appears in the list immediately.
            // - new: create a terminal row (id == uuid).
            // - resume: reuse the existing row (created above as fallback if missing);
            //   never duplicate an agent row. Just mark it running.
            if (store && rowId) {
                if (mode === 'new') {
                    try { store.createTerminalSession(rowId, user.id, name || 'Terminal session', currentDir, model || 'claude-opus-4-8'); } catch (_) {}
                } else if (mode === 'resume') {
                    if (!store.getSession(rowId)) {
                        try { store.createTerminalSession(rowId, user.id, name || 'Terminal session', currentDir, model || 'claude-opus-4-8'); } catch (_) {}
                    }
                    try { store.updateSession(rowId, { status: 'running' }); } catch (_) {}
                }
            }

            // For a fork, poll the project dir for the freshly-written uuid.
            if (forkPending) {
                const fp = forkPending;
                let tries = 0;
                const timer = setInterval(() => {
                    tries++;
                    const found = store?.detectNewSession?.(currentDir, fp.sinceMs - 1500, fp.parentId);
                    if (found) {
                        clearInterval(timer);
                        claudeId = found; rowId = found;
                        forkPending = null;
                        try { store.createTerminalSession(found, user.id, name || 'Fork', currentDir, model || 'claude-opus-4-8', fp.parentId); } catch (_) {}
                        try { ws.send(JSON.stringify({ type: 'forked', sessionId: found, parentId: fp.parentId })); } catch (_) {}
                    } else if (tries > 20) {
                        clearInterval(timer);
                    }
                }, 500);
            }

            proc.on('data', (data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data })); });
            proc.on('exit', (code) => {
                const exitCode = typeof code === 'number' ? code : 0;
                finalize();
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
                proc = null;
            });

            try { ws.send(JSON.stringify({ type: 'started', sessionId: rowId, cwd: currentDir, model: model || 'default', mode })); } catch (_) {}
        };

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
            switch (msg.type) {
                case 'start':
                    spawnTerm(msg);
                    break;
                case 'input':
                    if (!proc) spawnTerm({});
                    try { proc?.write(msg.data); } catch (_) {}
                    break;
                case 'resize':
                    try { proc?.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0)); } catch (_) {}
                    break;
                default:
                    break;
            }
        });

        ws.on('close', () => { finalize(); kill(); });
        ws.on('error', () => { kill(); });

        try { ws.send(JSON.stringify({ type: 'ready', user: user.displayName || user.email || 'you' })); } catch (_) {}
    });

    console.log('[Terminal] 🖥️  Interactive terminal WS on /term');
    return wss;
}
