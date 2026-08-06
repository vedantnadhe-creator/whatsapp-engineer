// Ollama integration for the session dropdown.
//
// Picking an Ollama model in the model dropdown routes THAT session to the local
// Ollama server (which proxies Ollama Cloud) instead of api.anthropic.com. Claude
// (Opus etc.) stays the default — this is a per-session opt-in switch, useful when
// the Anthropic limit is hit.
//
// Mechanism: Ollama speaks the Anthropic-compatible API at OLLAMA_BASE_URL. We
// tag Ollama models with an `ollama:` id prefix so the backend knows to (a) strip
// the prefix for the real `--model` value and (b) inject the Anthropic-override
// env onto the spawned `claude` process.

import config from './config.js';

export const OLLAMA_PREFIX = 'ollama:';
export const DEFAULT_OLLAMA_MODEL = `${OLLAMA_PREFIX}minimax-m3:cloud`;

// Curated fallback list — shown even before any model is pulled, and merged with
// whatever Ollama reports live. Small / sensible cloud models to start; edit these
// (or just pull more in Ollama) and the dropdown updates. The user will confirm
// the exact tags they want.
// minimax-m3 (vision + tools + thinking) — the single sanctioned Ollama fallback
// and the default for Tester / Business Analyst. Verified end-to-end via the
// Anthropic-compat /v1/messages path with image input.
// kimi-k2.7-code — also in the list for visibility, but it is currently BROKEN:
// it emits malformed tool_use IDs (functions.Read:41 etc.) that poison transcript
// parses and trigger Claude Code 400s. We keep it visible but redirect any attempt
// to use it to minimax-m3, and mark it disabled in the dropdown.
// kimi-k3 — newer generation, confirmed available in Ollama (vision + tools +
// thinking). Enabled, but NOT yet proven against the tool_use-ID bug that its
// k2.7 predecessor has; watch the first sessions before trusting it for long runs.
// glm-5.2 — tools + thinking with a 1M context, but NO vision, so screenshot /
// image steps will fail on it. Same unproven-tool_use-ID caveat as kimi-k3.
export const STATIC_OLLAMA_MODELS = [
    { id: DEFAULT_OLLAMA_MODEL, name: 'Ollama · minimax-m3 (cloud) 🖼️', description: 'Ollama Cloud — vision + tools + thinking' },
    { id: `${OLLAMA_PREFIX}kimi-k3:cloud`, name: 'Ollama · kimi-k3 (cloud) 🖼️', description: 'Ollama Cloud — vision + tools + thinking (newer kimi generation)' },
    { id: `${OLLAMA_PREFIX}glm-5.2:cloud`, name: 'Ollama · GLM 5.2 (cloud)', description: 'Ollama Cloud — tools + thinking, 1M context (no vision)' },
    { id: `${OLLAMA_PREFIX}kimi-k2.7-code:cloud`, name: 'Ollama · kimi-k2.7-code (cloud)', description: 'Ollama Cloud — code generation ⚠️ currently disabled', disabled: true, disabledReason: 'Emits invalid tool IDs that crash sessions — using minimax-m3 instead' },
];

// Models known to produce invalid Claude Code tool_use IDs. Any request to use
// one of these is silently redirected to DEFAULT_OLLAMA_MODEL at runtime so the
// session cannot crash with the '^[a-zA-Z0-9_-]+$' validation error.
const BROKEN_OLLAMA_MODELS = new Set([
    `${OLLAMA_PREFIX}kimi-k2.7-code:cloud`,
]);

export function isOllamaModel(id) {
    return typeof id === 'string' && id.startsWith(OLLAMA_PREFIX);
}

// Runtime guard: if a known-broken Ollama model is selected (from stale DB rows,
// direct API calls, or the dropdown before the UI disables it), redirect to the
// working default. Logs once per redirect so it is visible in the server logs.
export function safeOllamaModel(id) {
    if (!isOllamaModel(id)) return id;
    if (BROKEN_OLLAMA_MODELS.has(id)) {
        console.warn(`[Ollama] Redirecting broken model "${id}" to "${DEFAULT_OLLAMA_MODEL}"`);
        return DEFAULT_OLLAMA_MODEL;
    }
    return id;
}

// Strip the `ollama:` tag to get the real model name passed to `claude --model`.
export function ollamaModelName(id) {
    return isOllamaModel(id) ? id.slice(OLLAMA_PREFIX.length) : id;
}

// Build a dropdown entry from a raw model name (e.g. "kimi-k2:1t-cloud"). Accepts
// names with or without the `ollama:` prefix. Used for admin-added custom models.
export function ollamaModelEntry(name, description = 'Ollama (custom)') {
    const clean = String(name || '').trim();
    const id = clean.startsWith(OLLAMA_PREFIX) ? clean : `${OLLAMA_PREFIX}${clean}`;
    return { id, name: `Ollama · ${ollamaModelName(id)}`, description };
}

// Anthropic-override env that points `claude` at Ollama. Empty API key is REQUIRED
// — a non-empty ANTHROPIC_API_KEY would override the auth token and break routing.
export function ollamaEnv() {
    return {
        ANTHROPIC_BASE_URL: config.OLLAMA_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: config.OLLAMA_AUTH_TOKEN,
        ANTHROPIC_API_KEY: '',
    };
}

// Does `url` point at the local Ollama server? Compares host + port, treating
// 127.0.0.1 and localhost as the same host (the parent Claude session sets
// ANTHROPIC_BASE_URL to 127.0.0.1:11434 while our config default is localhost:11434).
function pointsAtOllama(url) {
    try {
        const u = new URL(url);
        const o = new URL(config.OLLAMA_BASE_URL);
        const hosts = new Set(['127.0.0.1', 'localhost']);
        return hosts.has(u.hostname) && hosts.has(o.hostname) && u.port === o.port;
    } catch { return false; }
}

// Strip Ollama-routing env that leaked in from the parent process — e.g. when the
// daemon was started from inside an Ollama-backed Claude session, the parent's
// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_*_MODEL all point
// at Ollama. If we leave them, a real (non-`ollama:`) model like claude-opus-4-8
// inherits them, gets routed at the local Ollama server, and 404s with
// "model_not_found" because Ollama doesn't host that model. Mutates + returns `env`.
//
// Only strips values that actually point at Ollama — a legitimate non-Ollama
// proxy (Headroom) or a real ANTHROPIC_API_KEY is preserved untouched.
export function stripLeakedOllamaEnv(env) {
    if (!pointsAtOllama(env.ANTHROPIC_BASE_URL)) return env;
    delete env.ANTHROPIC_BASE_URL;
    if (env.ANTHROPIC_AUTH_TOKEN === config.OLLAMA_AUTH_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
    if (env.ANTHROPIC_API_KEY === '') delete env.ANTHROPIC_API_KEY;
    // The parent set these aliases to its Ollama model (e.g. glm-5.2:cloud) to map
    // opus/sonnet/haiku onto Ollama. Drop them so the real model id is honoured.
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
        if (env[k] != null) delete env[k];
    }
    return env;
}

// Curated allowlist + admin-added custom names. We deliberately do NOT merge whatever
// Ollama has installed live (e.g. glm-5.2:cloud) — only the sanctioned static entry
// (minimax-m3) plus any explicit admin-added custom tags should appear in the dropdown.
export async function listOllamaModels(customNames = []) {
    const byId = new Map(STATIC_OLLAMA_MODELS.map((m) => [m.id, m]));
    // Admin-added models (from Settings) — take priority over static labels.
    for (const name of customNames) {
        if (!name || !String(name).trim()) continue;
        const entry = ollamaModelEntry(name);
        byId.set(entry.id, entry);
    }
    return [...byId.values()];
}
