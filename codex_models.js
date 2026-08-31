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
export const DEFAULT_CODEX_MODEL = `${CODEX_PREFIX}gpt-5.6-terra`;

// Codex model IDs accepted with a ChatGPT-backed Codex login.  A bare
// `gpt-5.6` is an API-style alias and Codex rejects it for ChatGPT accounts.
const CODEX_CATALOG = [
    { slug: 'gpt-5.6-terra', name: 'OpenAI · GPT-5.6 Terra', description: 'Balanced Codex model for everyday engineering work', default: true },
    { slug: 'gpt-5.6-sol', name: 'OpenAI · GPT-5.6 Sol', description: 'Highest-capability Codex model for complex work' },
    { slug: 'gpt-5.6-luna', name: 'OpenAI · GPT-5.6 Luna', description: 'Fastest GPT-5.6 Codex model for quick tasks' },
];

export function isCodexModel(id) {
    return typeof id === 'string' && id.startsWith(CODEX_PREFIX);
}

export function codexModelName(id) {
    return isCodexModel(id) ? id.slice(CODEX_PREFIX.length) : id;
}

export function safeCodexModel(id) {
    // Preserve existing sessions created before the valid ChatGPT Codex model
    // IDs were introduced. Both new and resumed turns then use a supported ID.
    return id === `${CODEX_PREFIX}gpt-5.6` ? DEFAULT_CODEX_MODEL : id;
}

// The CLI must exist before we offer the models, otherwise a session would spawn
// and die instantly with ENOENT.
export function isCodexInstalled() {
    try { return fs.existsSync(config.CODEX_BIN); } catch (_) { return false; }
}

// `codex login` normally stores credentials in $CODEX_HOME/auth.json. Keep this
// helper for diagnostics, but do not use it to gate the picker: the dashboard
// process can run with a different filesystem view from the Codex CLI, while the
// CLI itself remains the source of truth for whether its login is usable.
export function isCodexAuthed() {
    try { return fs.existsSync(`${config.CODEX_HOME}/auth.json`); } catch (_) { return false; }
}

export async function listCodexModels() {
    const installed = isCodexInstalled();
    const disabledReason = !installed
        ? `Codex CLI not found at ${config.CODEX_BIN}`
        : null;
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
export function buildCodexArgs({ model, prompt, threadId = null, workingDir, canEdit = true, imagePath = null, confined = false }) {
    const args = ['exec'];
    const isResume = Boolean(threadId);
    if (isResume) args.push('resume', threadId);
    args.push('--json', '--skip-git-repo-check');
    // `codex exec resume` has a narrower CLI surface than `codex exec`: it rejects
    // both --sandbox and --cd with exit code 2. It inherits the PTY's working
    // directory, and retains the original session's sandbox, so pass those options
    // only when creating a new thread.
    if (confined) {
        // Client-support sessions: neither of the two options below fits. The blanket
        // bypass would hand a commercial user unrestricted access to this box, and
        // read-only would break the job — sourcing writes an Excel workbook. So:
        // writes confined to the session's own workspace, network kept (the whole task
        // is fetching college pages), and no approval prompts because a dashboard PTY
        // has nobody to answer them.
        //
        // This is the Codex substitute for the PreToolUse guard on the Claude path.
        // Codex has no hook system, so the Bash/Skill allow-list cannot be reproduced
        // here; the sandbox bounds the blast radius instead of enumerating commands.
        if (!isResume) {
            args.push('--sandbox', codexSandbox(true));
            args.push('-c', 'sandbox_workspace_write.network_access=true');
        }
        args.push('-c', 'approval_policy="never"');
    } else if (canEdit) {
        // This is Codex's equivalent of Claude's
        // --dangerously-skip-permissions: automation must never wait for an
        // approval prompt, and developers get unrestricted command/file access.
        // It is supported by both `exec` and `exec resume`.
        // Do not use this for read-only tester sessions below.
        args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!isResume) {
            // A dashboard session has no interactive TTY to answer approval prompts.
            // Testers remain genuinely read-only even while prompts are suppressed.
            args.push('--sandbox', codexSandbox(false));
            args.push('-c', 'approval_policy="never"');
    } else {
        // `exec resume` does not accept --sandbox; it retains the read-only sandbox
        // chosen at thread creation. Keep approval prompts disabled for the PTY.
        args.push('-c', 'approval_policy="never"');
    }
    if (model) args.push('--model', model);
    if (!isResume && workingDir) args.push('--cd', workingDir);
    // One flag per file — `--image <FILE>...` is variadic, so `--image a b` would
    // swallow the prompt positional. Repeat the flag instead.
    for (const img of [].concat(imagePath || []).filter(Boolean)) args.push('--image', img);
    args.push(prompt);
    return args;
}
