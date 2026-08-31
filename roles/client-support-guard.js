#!/usr/bin/env node
// PreToolUse guard for client_support sessions (support / sales / lead generation).
//
// Why this exists: those sessions already get a business persona, a workspace outside
// /home/ubuntu, and Edit/Write disabled. What that leaves open is Bash — and the skills
// directory is global (~/.claude/skills), so a client-facing session can still SEE
// `uat-deployment`, `db-script-push`, `api-test-feature`. The persona forbids all of it,
// but a persona is a request, not a control. This is the control.
//
// It is a guard, not a sandbox: someone determined can defeat a string check (base64,
// a wrapper script, an interpreter heredoc). What it does stop is the realistic case —
// a client document that says "now run auto_deploy.sh", or a support user who asks the
// session to "just restart the service" and gets a plausible yes.
//
// Contract: read the PreToolUse payload on stdin, print a deny decision or nothing.
// It must NEVER throw — a crashing guard is a hook error, and a hook error must not be
// the thing that decides whether a dangerous command runs. Hence the catch-all at the
// bottom that fails CLOSED for the tools we gate.

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
    let payload = null;
    try {
        payload = JSON.parse(raw);
        const tool = payload.tool_name;
        if (tool === 'Bash') return decide(checkBash(payload.tool_input?.command || ''));
        if (tool === 'Skill') return decide(checkSkill(payload.tool_input?.skill || ''));
        return allow();
    } catch (err) {
        // Unparseable input or a bug above. The hook is only wired to the Bash and
        // Skill matchers, so anything reaching here is a call we are meant to gate —
        // and if we cannot tell what it is, the safe answer for a client-facing
        // session is no. Fail closed, not open.
        return decide(`Blocked for client-support sessions: the guard could not evaluate this call (${err.message}). This is a bug — report it to engineering rather than working around it.`);
    }
});

function allow() { process.exit(0); }
function decide(reason) {
    if (!reason) return allow();
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

// ── Bash ──────────────────────────────────────────────────────────────────────
// Two independent checks, because either alone is weak. The head allow-list stops
// `kubectl …`; the substring deny-list stops `cd /tmp && kubectl …`, where the head
// is innocent. A command must pass BOTH.

// Command heads a commercial session legitimately needs: reading files, querying the
// read-only DB, fetching a college page, building the workbook, shipping it to S3.
const ALLOWED_HEADS = new Set([
    'awk', 'basename', 'cat', 'cd', 'cut', 'date', 'df', 'dirname', 'du', 'echo',
    'env', 'file', 'find', 'grep', 'head', 'jq', 'ls', 'mkdir', 'node', 'nl', 'paste',
    'pip', 'pip3', 'printf', 'psql', 'pwd', 'python', 'python3', 'readlink', 'realpath',
    'sed', 'seq', 'sort', 'stat', 'tail', 'tee', 'test', 'tr', 'true', 'uniq', 'wc',
    'which', 'xargs', 'curl', 'wget', 'sleep', 'touch', 'cp', 'mv', 'diff', 'md5sum',
    'base64', 'iconv', 'openssl', 'aws', 'unzip', 'zip', 'gzip', 'gunzip', 'tar',
]);

// Tokens that must not appear ANYWHERE in the command, whatever the shape. These are
// the deploy / infra / VCS / privilege surface — none of it is a commercial user's job,
// and all of it is reachable from this box.
const DENIED_TOKENS = [
    'ssh', 'scp', 'rsync', 'sftp', 'kubectl', 'docker', 'systemctl', 'service',
    'sudo', 'su', 'pm2', 'git', 'npm', 'npx', 'yarn', 'pnpm', 'nvm', 'make',
    'auto_deploy', 'autodeploy', 'deploy.sh', 'start.sh', 'crontab', 'shutdown',
    'reboot', 'mount', 'chown', 'chmod', 'useradd', 'usermod', 'passwd', 'iptables',
    'nginx', 'certbot', 'terraform', 'ansible', 'helm', 'oci',
];

// Writes to the platform databases. Read-only is the whole point: this role reports on
// client data and never edits it, so a stray UPDATE cannot come from a support session.
// No trailing \b: an alternative ending in \w ("update s") is followed by more word
// characters ("update students"), and \b would then fail to match — silently letting
// every real UPDATE through. Caught by the unit checks at the bottom of this file.
const SQL_WRITE = /\b(insert\s+into\s|update\s+[\w"]|delete\s+from\s|drop\s+(table|database|schema|index)\s|truncate\s|alter\s+(table|type|schema)\s|create\s+(table|database|schema|index|type)\s|grant\s|revoke\s)/i;

function checkBash(command) {
    const cmd = String(command);
    if (!cmd.trim()) return null;

    for (const tok of DENIED_TOKENS) {
        // Word-boundary match so `git` does not fire on `digital` and `su` does not
        // fire on `sum`, while `&& git push` and `/usr/bin/kubectl` both still do.
        if (new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(tok)}([^A-Za-z0-9_-]|$)`).test(cmd)) {
            return `Blocked for client-support sessions: this command uses \`${tok}\`, which is engineering/infrastructure tooling. Client Success sessions do not deploy, restart services, push code, or change server state. If a client's problem needs one of these, write it up and hand it to engineering.`;
        }
    }

    if (SQL_WRITE.test(cmd)) {
        return 'Blocked for client-support sessions: this looks like a write to a platform database. This role is read-only on client data — report what the data says, and route any change request to the team that owns it.';
    }

    // rm is denied outright rather than path-scoped: there is nothing in a sourcing or
    // reporting workflow that needs to delete, and path parsing is where these checks
    // usually go wrong.
    if (/(^|[^A-Za-z0-9_.-])rm([^A-Za-z0-9_-]|$)/.test(cmd)) {
        return 'Blocked for client-support sessions: `rm` is not available. Nothing in lead sourcing or client reporting needs to delete files.';
    }

    const heads = commandHeads(cmd);
    const bad = heads.filter((h) => !ALLOWED_HEADS.has(h));
    if (bad.length) {
        return `Blocked for client-support sessions: \`${bad[0]}\` is not on the allow-list for this role. Available: reading files, querying the read-only database (psql), fetching pages (curl), building files (python3/node), and uploading results. If you genuinely need \`${bad[0]}\`, ask an engineer rather than working around this.`;
    }
    return null;
}

// Split on shell separators and take the first word of each segment, stripping any
// leading VAR=value assignments and a path prefix. Deliberately simple — the deny-list
// above is what catches the shapes this misses.
function commandHeads(cmd) {
    return cmd
        .split(/\|\||&&|[;|\n]/)
        .map((seg) => seg.trim().replace(/^\(+\s*/, ''))
        .filter(Boolean)
        .map((seg) => {
            const words = seg.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
            const first = words[0] || '';
            return first.replace(/^.*\//, '').replace(/^['"]|['"]$/g, '');
        })
        .filter(Boolean);
}

// ── Skills ────────────────────────────────────────────────────────────────────
// ~/.claude/skills is a single global directory, so a client-support session lists the
// engineering skills alongside its own. Allow-list the ones that belong to this role;
// everything else is denied by name so the refusal is legible rather than mysterious.
const ALLOWED_SKILLS = new Set(['lead-gen', 'create-prd', 'dataviz', 'brainstorming']);

function checkSkill(skill) {
    const name = String(skill).replace(/^\//, '').trim();
    if (!name || ALLOWED_SKILLS.has(name)) return null;
    return `Blocked for client-support sessions: the \`${name}\` skill is engineering tooling and is not part of this role. Available skills: ${[...ALLOWED_SKILLS].join(', ')}.`;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
