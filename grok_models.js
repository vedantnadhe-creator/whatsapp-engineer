// xAI Grok integration for the session dropdown.
//
// Picking a Grok model routes THAT session through a local translation proxy
// (grok_proxy.js, mounted inside the dashboard's Express app at /grok/v1/messages)
// instead of api.anthropic.com. Unlike Ollama, xAI's API is OpenAI-schema, not
// Anthropic-schema, so `claude` can't be pointed at it directly — the proxy
// translates Anthropic Messages <-> xAI chat-completions in both directions.
// Mirrors ollama_models.js's shape/mechanism so claude_manager.js and
// dashboard.js can treat both providers the same way.

import config from './config.js';

export const GROK_PREFIX = 'grok:';
export const DEFAULT_GROK_MODEL = `${GROK_PREFIX}grok-4.5`;

export const STATIC_GROK_MODELS = [
    {
        id: DEFAULT_GROK_MODEL,
        name: 'xAI · Grok 4.5',
        description: 'xAI Grok — via local Anthropic-compat translation proxy',
        ...(config.GROK_API_KEY ? {} : { disabled: true, disabledReason: 'Set GROK_API_KEY in .env to enable' }),
    },
];

export function isGrokModel(id) {
    return typeof id === 'string' && id.startsWith(GROK_PREFIX);
}

export function grokModelName(id) {
    return isGrokModel(id) ? id.slice(GROK_PREFIX.length) : id;
}

// No known-broken Grok models yet — kept for symmetry with safeOllamaModel so
// claude_manager.js can call both guards the same way regardless of provider.
export function safeGrokModel(id) {
    return id;
}

export async function listGrokModels() {
    return STATIC_GROK_MODELS;
}

// Anthropic-override env that points `claude` at our local Grok translation proxy.
// Empty API key is REQUIRED — a non-empty ANTHROPIC_API_KEY would override the auth
// token and break routing. ANTHROPIC_AUTH_TOKEN is just the shared secret the proxy
// checks; the real xAI key never leaves the server (injected server-side in grok_proxy.js).
export function grokEnv() {
    return {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.GROK_PROXY_PORT}/grok`,
        ANTHROPIC_AUTH_TOKEN: config.GROK_PROXY_TOKEN,
        ANTHROPIC_API_KEY: '',
    };
}

function pointsAtGrokProxy(url) {
    try {
        const u = new URL(url);
        const hosts = new Set(['127.0.0.1', 'localhost']);
        return hosts.has(u.hostname) && u.port === String(config.GROK_PROXY_PORT) && u.pathname.startsWith('/grok');
    } catch { return false; }
}

// Strip Grok-routing env that leaked in from the parent process — same rationale
// as stripLeakedOllamaEnv: a real (non-`grok:`) model must not inherit these.
export function stripLeakedGrokEnv(env) {
    if (!pointsAtGrokProxy(env.ANTHROPIC_BASE_URL)) return env;
    delete env.ANTHROPIC_BASE_URL;
    if (env.ANTHROPIC_AUTH_TOKEN === config.GROK_PROXY_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
    if (env.ANTHROPIC_API_KEY === '') delete env.ANTHROPIC_API_KEY;
    return env;
}
