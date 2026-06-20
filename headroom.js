// Headroom context-compression integration.
//
// Headroom (https://github.com/chopratejas/headroom) runs a local Anthropic-
// compatible proxy that compresses prompts/tool-output before forwarding to the
// real provider — fewer tokens, same answers. We expose it as an admin on/off
// switch: when ON, Claude sessions get ANTHROPIC_BASE_URL pointed at the proxy.
//
// Auth is NOT overridden — Claude Code keeps using its own login; the proxy just
// passes the auth through to Anthropic. Headroom does not apply to Ollama
// sessions (those already own ANTHROPIC_BASE_URL).

import config from './config.js';

// Env that routes a `claude` process through the Headroom proxy. Base URL only —
// the session's normal Anthropic auth is preserved and forwarded by the proxy.
export function headroomEnv() {
    return { ANTHROPIC_BASE_URL: config.HEADROOM_BASE_URL };
}

// Is the admin toggle on? Stored in the generic settings table.
export function isHeadroomEnabled(store) {
    try { return store?.getSetting?.('headroom_enabled') === 'true'; } catch (_) { return false; }
}

// Best-effort health probe — never throws. Returns true only if the proxy answers.
export async function probeHeadroom() {
    const bases = ['/health', '/healthz', '/'];
    for (const p of bases) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 1200);
            const res = await fetch(`${config.HEADROOM_BASE_URL}${p}`, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok || res.status === 404) return true; // listening = good enough
        } catch (_) { /* try next path */ }
    }
    return false;
}
