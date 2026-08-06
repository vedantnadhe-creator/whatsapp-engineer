// OpenAI Codex integration for the session dropdown.
//
// Picking a Codex model runs THAT session through the `codex` CLI instead of
// `claude` — a different agent binary, not a different endpoint. Codex has its own
// agent loop, sandbox and session store, so claude_manager.js branches on the
// provider to build `codex exec` arguments and to translate Codex's JSONL events
// into the Claude event shapes the rest of the pipeline already understands
// (see codex_events.js).
//
// Auth is the CLI's own: `codex login` writes ~/.codex/auth.json (ChatGPT plan
// credits) or an API key. We deliberately never set CODEX_API_KEY, so a plan
// subscription is used when one is present.

import fs from 'fs';
import config from './config.js';

export const CODEX_PREFIX = 'codex:';
export const DEFAULT_CODEX_MODEL = `${CODEX_PREFIX}gpt-5.6`;

// Model slugs the installed codex binary accepts (`codex exec -m <MODEL>`).
const CODEX_CATALOG = [
    { slug: 'gpt-5.6', name: 'OpenAI · GPT-5.6 (Codex)', description: 'Newest OpenAI frontier model — runs via the Codex agent' },
    { slug: 'gpt-5.5', name: 'OpenAI · GPT-5.5 (Codex)', description: 'Previous frontier generation — runs via the Codex agent' },
    { slug: 'gpt-5.3-codex', name: 'OpenAI · GPT-5.3 Codex', description: 'Coding-tuned Codex model' },
    { slug: 'gpt-5.1-codex-mini', name: 'OpenAI · Codex Mini', description: 'Cheapest/fastest Codex tier — quick edits and lookups' },
];

export function isCodexModel(id) {
    return typeof id === 'string' && id.startsWith(CODEX_PREFIX);
}

export function codexModelName(id) {
    return isCodexModel(id) ? id.slice(CODEX_PREFIX.length) : id;
}

// No known-broken Codex models — kept for symmetry with the other providers so
// claude_manager.js can call every guard the same way.
export function safeCodexModel(id) {
    return id;
}

// The CLI must exist before we offer the models, otherwise a session would spawn
// and die instantly with ENOENT.
export function isCodexInstalled() {
    try { return fs.existsSync(config.CODEX_BIN); } catch (_) { return false; }
}

// `codex login` stores credentials in $CODEX_HOME/auth.json. Absent that file the
// binary runs but every turn fails with 401, so surface it as a disabled reason
// rather than letting users pick a model that cannot work.
export function isCodexAuthed() {
    try { return fs.existsSync(`${config.CODEX_HOME}/auth.json`); } catch (_) { return false; }
}

export async function listCodexModels() {
    const installed = isCodexInstalled();
    const authed = installed && isCodexAuthed();
    const disabledReason = !installed
        ? `Codex CLI not found at ${config.CODEX_BIN}`
        : (!authed ? 'Run `codex login` on the server to use your ChatGPT plan' : null);
    return CODEX_CATALOG.map(m => ({
        id: `${CODEX_PREFIX}${m.slug}`,
        name: m.name,
        description: m.description,
        ...(disabledReason ? { disabled: true, disabledReason } : {}),
    }));
}

// Codex reads auth/config from CODEX_HOME. Pinning it explicitly keeps sessions off
// whatever HOME the dashboard process happens to have, and leaves the door open to
// per-session credential isolation later.
export function codexEnv() {
    return { CODEX_HOME: config.CODEX_HOME };
}

// Read-only testers must not be able to edit files. Claude does this with
// --disallowedTools; Codex enforces it in the sandbox, which is stronger — the
// model simply cannot write, rather than being asked not to.
export function codexSandbox(canEdit) {
    return canEdit ? 'workspace-write' : 'read-only';
}

// Argument list for a turn. `threadId` resumes an existing Codex session; omit it
// to start a new one. Prompt is passed as a positional arg, matching the CLI.
export function buildCodexArgs({ model, prompt, threadId = null, workingDir, canEdit = true, imagePath = null }) {
    const args = ['exec'];
    if (threadId) args.push('resume', threadId);
    args.push('--json', '--skip-git-repo-check');
    args.push('--sandbox', codexSandbox(canEdit));
    // Never pause for interactive approval — there is no TTY to answer the prompt,
    // so the turn would hang forever. The sandbox above is what actually constrains it.
    args.push('-c', 'approval_policy="never"');
    if (model) args.push('--model', model);
    if (workingDir) args.push('--cd', workingDir);
    if (imagePath) args.push('--image', imagePath);
    args.push(prompt);
    return args;
}
