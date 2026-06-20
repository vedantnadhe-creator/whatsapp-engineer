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

// Curated fallback list — shown even before any model is pulled, and merged with
// whatever Ollama reports live. Small / sensible cloud models to start; edit these
// (or just pull more in Ollama) and the dropdown updates. The user will confirm
// the exact tags they want.
export const STATIC_OLLAMA_MODELS = [
    { id: `${OLLAMA_PREFIX}gpt-oss:20b-cloud`, name: 'Ollama · gpt-oss 20B (cloud)', description: 'Ollama Cloud — small, fast fallback' },
    { id: `${OLLAMA_PREFIX}qwen3-coder:480b-cloud`, name: 'Ollama · qwen3-coder (cloud)', description: 'Ollama Cloud — coding-tuned fallback' },
];

export function isOllamaModel(id) {
    return typeof id === 'string' && id.startsWith(OLLAMA_PREFIX);
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

// Dynamic list: curated fallbacks + admin-added custom names + whatever the running
// Ollama actually has (deduped by id). Never throws — if Ollama is down or slow we
// still return the static + custom entries so the endpoint stays fast and healthy.
export async function listOllamaModels(customNames = []) {
    const byId = new Map(STATIC_OLLAMA_MODELS.map((m) => [m.id, m]));
    // Admin-added models (from Settings) — take priority over static labels.
    for (const name of customNames) {
        if (!name || !String(name).trim()) continue;
        const entry = ollamaModelEntry(name);
        byId.set(entry.id, entry);
    }
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
            const data = await res.json();
            for (const m of data?.models || []) {
                const real = m?.name || m?.model;
                if (!real) continue;
                const id = `${OLLAMA_PREFIX}${real}`;
                byId.set(id, { id, name: `Ollama · ${real}`, description: 'Ollama (installed)' });
            }
        }
    } catch (_) {
        // Ollama not reachable — fall back to the curated list silently.
    }
    return [...byId.values()];
}
