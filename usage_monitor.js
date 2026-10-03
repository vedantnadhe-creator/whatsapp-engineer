// Usage monitor — real numbers only, from two sources:
//
// 1. Plan limits (session / weekly %) straight from the providers, using the
//    same OAuth logins the CLIs use on this box:
//      Claude Code → GET api.anthropic.com/api/oauth/usage   (~/.claude/.credentials.json)
//      Codex       → GET chatgpt.com/backend-api/wham/usage  ($CODEX_HOME/auth.json)
//    Both are the endpoints the CLIs' own /usage screens read. They are not
//    public APIs: a shape change shows up as a per-provider error, never a crash.
//    We only read the tokens — refreshing them is left to the CLIs, which rotate
//    refresh tokens and would race us.
//
// 2. Token usage per session/user, parsed from the CLIs' own transcripts
//    (~/.claude/projects/**.jsonl and $CODEX_HOME/sessions/**.jsonl), indexed
//    incrementally by byte offset so a refresh only reads what was appended.
//
// ponytail: the index lives in memory and is rebuilt on restart (~2-3 GB of
// transcripts, a one-off background scan). Claude Code deletes transcripts after
// 30 days, so history is capped at that. Persist hourly buckets to SQLite if
// either becomes a problem.

import fs from 'fs';
import os from 'os';
import path from 'path';
import config from './config.js';

const HOME = os.homedir();
const CLAUDE_CREDS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), '.credentials.json');
const CLAUDE_PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects');
const CODEX_HOME = config.CODEX_HOME;
const HISTORY_MS = 31 * 24 * 3600 * 1000;
const LIMITS_TTL_MS = 60 * 1000;
const RESCAN_MS = 60 * 1000;
const CHUNK = 4 * 1024 * 1024;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

// ── Plan limits ──────────────────────────────────────────────

async function getJson(url, headers) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(res.status === 401 ? 'login expired — run the CLI once to refresh it' : `HTTP ${res.status}`);
    return res.json();
}

const pct = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function claudeLimits() {
    const oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8')).claudeAiOauth;
    if (!oauth?.accessToken) throw new Error('Claude Code is not logged in with a subscription');
    const u = await getJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
    });
    const win = (w, label, minutes) => w && { label, usedPercent: pct(w.utilization), resetsAt: w.resets_at || null, windowMinutes: minutes };
    return {
        plan: [oauth.subscriptionType, oauth.rateLimitTier].filter(Boolean).join(' · '),
        windows: [
            win(u.five_hour, 'Session (5 h)', 300),
            win(u.seven_day, 'Weekly · all models', 10080),
            win(u.seven_day_opus, 'Weekly · Opus', 10080),
            win(u.seven_day_sonnet, 'Weekly · Sonnet', 10080),
        ].filter(Boolean),
        extraUsage: u.extra_usage ? { enabled: !!u.extra_usage.is_enabled, used: u.extra_usage.used_credits ?? null, limit: u.extra_usage.monthly_limit ?? null } : null,
    };
}

async function codexLimits() {
    const auth = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'));
    if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) {
        throw new Error('Codex is on an API key, which has no plan limits');
    }
    const u = await getJson('https://chatgpt.com/backend-api/wham/usage', {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id || '',
    });
    const win = (w) => {
        if (!w) return null;
        const minutes = Math.round((w.limit_window_seconds || 0) / 60);
        const label = minutes >= 10080 ? 'Weekly' : minutes >= 60 ? `Session (${Math.round(minutes / 60)} h)` : `${minutes} min`;
        return { label, usedPercent: pct(w.used_percent), resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null, windowMinutes: minutes };
    };
    const rl = u.rate_limit || {};
    return {
        plan: u.plan_type || null,
        account: u.email || null,
        limitReached: !!rl.limit_reached,
        windows: [win(rl.primary_window), win(rl.secondary_window)].filter(Boolean),
        credits: u.credits ? { balance: u.credits.balance, unlimited: !!u.credits.unlimited } : null,
    };
}

let limitsCache = null;
export async function getLimits({ force = false } = {}) {
    if (!force && limitsCache && Date.now() - limitsCache.at < LIMITS_TTL_MS) return limitsCache.value;
    const settle = async (fn) => {
        try { return await fn(); } catch (err) { return { error: err.message }; }
    };
    const [claude, codex] = await Promise.all([settle(claudeLimits), settle(codexLimits)]);
    const value = { claude, codex, fetchedAt: new Date().toISOString() };
    limitsCache = { at: Date.now(), value };
    return value;
}

// ── Transcript index ─────────────────────────────────────────

// file path → { offset, key, provider, lastId, lastUsage, prevTotal, model }
const files = new Map();
// `${provider}|${key}|${hourMs}|${model}` → { provider, key, hour, model, input, cacheWrite, cacheRead, output, turns }
const buckets = new Map();
let scanPromise = null;
let lastScanAt = 0;

function addUsage(provider, key, ts, model, u, sign = 1) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return;
    const hour = t - (t % 3600000);
    const id = `${provider}|${key}|${hour}|${model}`;
    let b = buckets.get(id);
    if (!b) {
        b = { provider, key, hour, model, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 };
        buckets.set(id, b);
    }
    b.input += sign * u.input;
    b.cacheWrite += sign * u.cacheWrite;
    b.cacheRead += sign * u.cacheRead;
    b.output += sign * u.output;
    b.turns += sign;
}

function parseClaudeLine(f, line) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const m = o.message;
    if (o.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') return;
    const u = {
        input: m.usage.input_tokens || 0,
        cacheWrite: m.usage.cache_creation_input_tokens || 0,
        cacheRead: m.usage.cache_read_input_tokens || 0,
        output: m.usage.output_tokens || 0,
    };
    // One API response is written as one line per content block, all sharing
    // message.id. Count it once, keeping the latest (final) usage.
    if (m.id && m.id === f.lastId) addUsage('claude', f.key, f.lastTs, m.model, f.lastUsage, -1);
    addUsage('claude', f.key, o.timestamp, m.model, u);
    f.lastId = m.id;
    f.lastUsage = u;
    f.lastTs = o.timestamp;
}

function parseCodexLine(f, line) {
    if (line.includes('"turn_context"')) {
        try { f.model = JSON.parse(line).payload?.model || f.model; } catch { /* keep previous */ }
        return;
    }
    if (!line.includes('"token_count"')) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const tot = o.payload?.info?.total_token_usage;
    if (!tot) return;
    // Counters are cumulative and token_count repeats; diff against the last one.
    const prev = f.prevTotal || { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
    const d = (k) => Math.max(0, (tot[k] || 0) - (prev[k] || 0));
    const u = {
        input: Math.max(0, d('input_tokens') - d('cached_input_tokens') - d('cache_write_input_tokens')),
        cacheWrite: d('cache_write_input_tokens'),
        cacheRead: d('cached_input_tokens'),
        output: d('output_tokens'),
    };
    f.prevTotal = tot;
    if (u.input + u.cacheWrite + u.cacheRead + u.output > 0) addUsage('codex', f.key, o.timestamp, f.model || 'codex', u);
}

async function listJsonl(dir, out = []) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
    await Promise.all(entries.map((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return listJsonl(p, out);
        if (e.name.endsWith('.jsonl')) out.push(p);
        return null;
    }));
    return out;
}

// Claude: <project>/<uuid>.jsonl, and subagents under <project>/<uuid>/subagents/*.jsonl
// roll up to the parent conversation. Codex: rollout-<ts>-<thread uuid>.jsonl.
function claudeKey(p) {
    const rel = path.relative(CLAUDE_PROJECTS, p).split(path.sep);
    return rel.length > 2 ? rel[1] : path.basename(p, '.jsonl');
}

async function scanFile(p, provider) {
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (Date.now() - st.mtimeMs > HISTORY_MS) return;
    let f = files.get(p);
    if (!f) {
        const key = provider === 'claude' ? claudeKey(p) : (path.basename(p).match(UUID_RE)?.[1] || path.basename(p));
        f = { offset: 0, key, provider };
        files.set(p, f);
    }
    if (st.size < f.offset) return; // truncated/rewritten — leave what we counted
    if (st.size === f.offset) return;
    const fh = await fs.promises.open(p, 'r');
    try {
        const parse = provider === 'claude' ? parseClaudeLine : parseCodexLine;
        let carry = '';
        let pos = f.offset;
        const buf = Buffer.alloc(CHUNK);
        while (pos < st.size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
            if (!bytesRead) break;
            pos += bytesRead;
            const text = carry + buf.toString('utf8', 0, bytesRead);
            const lines = text.split('\n');
            carry = lines.pop();
            for (const line of lines) parse(f, line);
        }
        // Only advance past complete lines; a half-written tail is re-read next time.
        f.offset = pos - Buffer.byteLength(carry, 'utf8');
    } finally {
        await fh.close();
    }
}

async function scanAll() {
    const [claude, codex] = await Promise.all([
        listJsonl(CLAUDE_PROJECTS),
        listJsonl(path.join(CODEX_HOME, 'sessions')),
    ]);
    // Sequential on purpose: keeps IO polite and the event loop responsive.
    for (const p of claude) await scanFile(p, 'claude');
    for (const p of codex) await scanFile(p, 'codex');
    lastScanAt = Date.now();
}

export function refreshIndex() {
    if (!scanPromise) {
        scanPromise = scanAll()
            .catch((err) => console.warn('[Usage] transcript scan failed:', err.message))
            .finally(() => { scanPromise = null; });
    }
    return scanPromise;
}

export function isIndexReady() {
    return lastScanAt > 0;
}

// Account-wide usage since `sinceMs`: totals per provider and tokens per day.
export async function getUsage(sinceMs) {
    if (!lastScanAt) await refreshIndex();
    else if (Date.now() - lastScanAt > RESCAN_MS) refreshIndex(); // stale-while-revalidate

    const zero = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 });
    const add = (t, b) => {
        t.input += b.input;
        t.cacheWrite += b.cacheWrite;
        t.cacheRead += b.cacheRead;
        t.output += b.output;
        t.turns += b.turns;
    };
    const totals = { claude: zero(), codex: zero() };
    const daily = new Map();

    for (const b of buckets.values()) {
        if (b.hour + 3600000 <= sinceMs || b.turns <= 0) continue;
        add(totals[b.provider], b);

        const day = new Date(b.hour).toISOString().slice(0, 10);
        if (!daily.has(day)) daily.set(day, { day, claude: 0, codex: 0 });
        daily.get(day)[b.provider] += b.input + b.cacheWrite + b.output;
    }

    return {
        indexedAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
        totals,
        daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
}
