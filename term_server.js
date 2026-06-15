// ---------------------------------------------------------------------------
// term_server.js — interactive web terminal (the /sessions/v2 workspace)
//
// This is the LEGITIMATE, human-driven path: a real person types into a real
// interactive `claude` REPL running in a PTY, streamed to the browser via
// xterm.js. Because it is genuine interactive use (no `--print` / headless
// flag), it draws from the normal Claude subscription pool — NOT the Agent SDK
// credit pool. It deliberately does NOT automate or script the session.
//
// Protocol (JSON frames over WS at /term):
//   client → server: {type:'start', cols, rows, model?, cwd?}
//                     {type:'input', data}
//                     {type:'resize', cols, rows}
//   server → client: {type:'ready'}            after auth ok
//                     {type:'started', cwd, model}
//                     {type:'output', data}     raw PTY bytes
//                     {type:'exit', code}
//                     {type:'error', message}
// ---------------------------------------------------------------------------

import pty from 'node-pty';
import { WebSocketServer } from 'ws';
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

// Returns a noServer WebSocketServer. The caller routes /term upgrades to it via
// a single server 'upgrade' handler (see dashboard.js) — two {server,path}
// servers on one HTTP server abort each other's upgrades in ws 8.x.
export function attachTerminalServer() {
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws, req) => {
        // Same auth as the dashboard: signed wa_token cookie (or bearer header).
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies.wa_token || (req.headers.authorization || '').replace('Bearer ', '');
        const user = token ? verifyJwt(token) : null;
        if (!user) {
            try { ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); } catch (_) {}
            return ws.close();
        }

        let proc = null;
        const kill = () => { try { proc?.kill(); } catch (_) {} proc = null; };

        const spawnTerm = ({ cols = 80, rows = 24, model, cwd } = {}) => {
            if (proc) return;
            const bin = config.CLAUDE_BIN;
            // Interactive REPL — NO --print. Optional --model so the user can pick
            // a model from the v2 header. Any non-Anthropic routing (CCR/GLM/etc.)
            // would be layered via env, not here.
            const args = [];
            if (model && model !== 'default') args.push('--model', model);

            // Confine cwd to DEFAULT_WORKING_DIR for safety.
            const base = config.DEFAULT_WORKING_DIR;
            const workingDir = (cwd && String(cwd).startsWith(base)) ? cwd : base;

            try {
                proc = pty.spawn(bin, args, {
                    name: 'xterm-256color',
                    cols: Math.max(20, cols | 0),
                    rows: Math.max(5, rows | 0),
                    cwd: workingDir,
                    env: { ...process.env, TERM: 'xterm-256color' },
                });
            } catch (err) {
                try { ws.send(JSON.stringify({ type: 'error', message: `Spawn failed: ${err.message}` })); } catch (_) {}
                return;
            }

            proc.on('data', (data) => {
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
            });
            proc.on('exit', (code) => {
                const exitCode = typeof code === 'number' ? code : 0;
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
                proc = null;
            });

            try { ws.send(JSON.stringify({ type: 'started', cwd: workingDir, model: model || 'default' })); } catch (_) {}
        };

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
            switch (msg.type) {
                case 'start':
                    spawnTerm(msg);
                    break;
                case 'input':
                    if (!proc) spawnTerm({});       // lazy spawn if client sent input first
                    try { proc?.write(msg.data); } catch (_) {}
                    break;
                case 'resize':
                    try { proc?.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0)); } catch (_) {}
                    break;
                default:
                    break;
            }
        });

        ws.on('close', kill);
        ws.on('error', kill);

        try { ws.send(JSON.stringify({ type: 'ready', user: user.displayName || user.email || 'you' })); } catch (_) {}
    });

    console.log('[Terminal] 🖥️  Interactive terminal WS on /term');
    return wss;
}
