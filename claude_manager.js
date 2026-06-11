// ============================================================
// claude_manager.js — Spawns, resumes, and monitors Claude Code
// ============================================================

import pty from 'node-pty';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

const KB_DIR = config.KB_DIR;
const KB_HINT = `[Context: Knowledge Base is a local git repo at ${KB_DIR}. Structure: pluginlive.md (company overview), Assessment/ (aptitude, communication, custom, role-based, scheduling), ATS/ (Admin, Corporate, Institute, Student, ElasticSearch), Infrastructure/ (servers, deployment, MCP, skills). To search: grep -rl "<term>" ${KB_DIR} --include="*.md". To read a doc: cat ${KB_DIR}/<path>. To update/create: write to ${KB_DIR}/<path> then cd ${KB_DIR} && git add -A && git commit -m "<msg>" && git push origin main. Read only what's relevant to the current task — do not read all docs upfront. The KB lives ONLY in this GitHub repo — there is no Outline wiki; never call app.getoutline.com or any Outline API.]`;


// Tester role persona — injected for sessions with mode === 'tester' (instead of a
// separate repo CLAUDE.md like design mode, since testers work on the real code repo).
const TESTER_PROMPT = `[ROLE: TESTER] You are operating as a QA tester, not a developer. Your job is to verify the change under test — NOT to build features.
SOURCE OF TRUTH — derive expected behavior in THIS strict priority order, do NOT jump to reading code first:
  1. PRDs — the product requirements are the primary spec. If the tester's instruction names a PRD or links one, use it. PRDs live as public HTML on S3 (links shared by the developer); the create-prd skill produces them.
  2. Knowledge Base — the pluginlive-kb GitHub repo cloned at /home/ubuntu/pluginlive-kb. Search it: grep -rl "<term>" /home/ubuntu/pluginlive-kb --include="*.md", then read the relevant doc (structure: pluginlive.md, Assessment/, ATS/, Infrastructure/). This describes current production-truth behavior.

Work AUTONOMOUSLY: do NOT pause to ask the user for a PRD, acceptance criteria, scope, or permission to proceed. Pull the expected behavior from the PRD/KB (and the tester's instruction), then just start testing. Only surface a question at the very end if a finding genuinely cannot be resolved — never block the run waiting on an answer. Focus on:
- Understanding what changed and the expected behavior (from PRD/KB first; code only if neither covers it).
- Writing clear, structured test cases (happy path, edge cases, negative cases).
- Reproducing reported behavior and verifying it against expectations.
- Running tests / read-only checks and reporting findings: what passed, what failed, exact repro steps, and severity.
REPORTING — the bug report must contain ONLY these, nothing more:
  • WHAT the bug is — the observable wrong behavior (symptom, where it happens, repro steps, severity).
  • WHY it happens — the root cause: the single explanation of what is going wrong (e.g. "the API returns the image URL but the frontend deletes the file before render").
You MAY read code (read-only) to pin down the root cause, but you must NOT output any fix: no code suggestions, no diffs, no patches, no "you should change X to Y", no snippets of corrected code. Do NOT recommend how to fix it. Stop at WHAT + WHY. Fixing is the developer's job, not yours.
Prefer producing test cases, test scripts, and bug reports over changing product code.`;

// --dangerously-skip-permissions cannot be used as root — use settings-based permissions instead
const IS_ROOT = process.getuid?.() === 0;
const SKIP_PERMS = IS_ROOT ? [] : ['--dangerously-skip-permissions'];

// Tools that mutate files — disabled (via --disallowedTools) for read-only testers.
const EDIT_TOOLS = 'Edit,Write,NotebookEdit,MultiEdit';

class ClaudeManager extends EventEmitter {
    constructor(sessionStore) {
        super();
        this.store = sessionStore;
        this.processes = new Map();
        this._lastNotify = {};
    }

    async startSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'claude-opus-4-8', opts = {}) {
        const sessionId = `WA-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, model);
        this.store.addMessage(sessionId, 'user', task);
        // Apply role-driven mode/edit-access BEFORE spawning so _roleAugment (tester
        // persona + read-only gating) takes effect on the very first turn.
        const updates = {};
        if (opts.mode) updates.mode = opts.mode;
        if (opts.editAccess !== undefined) updates.edit_access = opts.editAccess ? 1 : 0;
        if (Object.keys(updates).length) this.store.updateSession(sessionId, updates);
        this._spawnNew(sessionId, task, dir, imagePath, model);
        return { sessionId };
    }

    async startAutonomousSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'claude-opus-4-8') {
        return this.startSession(userPhone, task, workingDir, imagePath, ownerId, model);
    }

    async forkSession(parentSessionId, task, userPhone, ownerId = null, model = null, opts = {}) {
        const parent = this.store.getSession(parentSessionId);
        if (!parent) throw new Error(`Session ${parentSessionId} not found`);

        const sessionId = `WA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const dir = parent.working_dir || config.DEFAULT_WORKING_DIR;
        const sessionModel = model || parent.model || 'claude-opus-4-8';

        // Build context summary from parent session's messages
        const parentMessages = this.store.getMessages(parentSessionId, 50);
        const contextSummary = this._buildForkContext(parent, parentMessages);

        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, sessionModel);

        // Build a user-visible summary for the forked session
        const visibleSummary = this._buildVisibleSummary(parent, parentMessages);
        this.store.addMessage(sessionId, 'system', visibleSummary);
        this.store.addMessage(sessionId, 'user', task);
        // Carry mode/edit-access onto the fork (e.g. tester forks → mode 'tester' with the
        // tester's code-edit permission) BEFORE spawning, so _roleAugment picks it up.
        const updates = { status: 'running' };
        if (opts.mode) updates.mode = opts.mode;
        if (opts.editAccess !== undefined) updates.edit_access = opts.editAccess ? 1 : 0;
        this.store.updateSession(sessionId, updates);

        // Start a fresh session with parent context + new task (carry any attached file)
        const forkPrompt = `${contextSummary}\n\n---\n\nNew task (forked from session ${parentSessionId}):\n${task}`;
        this._spawnNew(sessionId, forkPrompt, dir, opts.imagePath || null, sessionModel);
        return { sessionId, forkedFrom: parentSessionId };
    }

    // Merge two or more sessions into one new session. Each parent is compacted
    // (same context-summary used by fork), then all summaries are combined and a
    // fresh session is spawned that carries the full merged context + a new task.
    async mergeSessions(parentSessionIds = [], task, userPhone, ownerId = null, model = null, opts = {}) {
        const parents = [...new Set(parentSessionIds)]
            .map(id => this.store.getSession(id))
            .filter(Boolean);
        if (parents.length < 2) throw new Error('Merge requires at least 2 valid sessions');

        const sessionId = `WA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const dir = parents[0].working_dir || config.DEFAULT_WORKING_DIR;
        const sessionModel = model || parents[0].model || 'claude-opus-4-8';

        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, sessionModel);

        // Compact each parent and combine into one context + one visible summary.
        const contextBlocks = [];
        const visibleBlocks = [
            `**Merged from ${parents.length} sessions:** ${parents.map(p => `\`${p.id}\``).join(', ')}`,
            '',
        ];
        for (const p of parents) {
            const msgs = this.store.getMessages(p.id, 50);
            contextBlocks.push(this._buildForkContext(p, msgs));
            visibleBlocks.push(this._buildVisibleSummary(p, msgs));
            visibleBlocks.push('');
        }

        this.store.addMessage(sessionId, 'system', visibleBlocks.join('\n'));
        this.store.addMessage(sessionId, 'user', task);

        const updates = { status: 'running' };
        if (opts.mode) updates.mode = opts.mode;
        if (opts.editAccess !== undefined) updates.edit_access = opts.editAccess ? 1 : 0;
        this.store.updateSession(sessionId, updates);

        const mergedContext = contextBlocks.join('\n\n================ NEXT SESSION ================\n\n');
        const mergePrompt = `${mergedContext}\n\n---\n\nThe above are ${parents.length} prior sessions (${parents.map(p => p.id).join(', ')}) compacted and merged together. Use the combined context from all of them.\n\nNew task:\n${task}`;
        this._spawnNew(sessionId, mergePrompt, dir, null, sessionModel);
        return { sessionId, mergedFrom: parents.map(p => p.id) };
    }

    _buildVisibleSummary(parentSession, messages) {
        const lines = [];
        lines.push(`**Forked from session \`${parentSession.id}\`**`);
        lines.push(`**Original task:** ${parentSession.task || 'N/A'}`);
        lines.push(`**Status:** ${parentSession.status || 'unknown'}`);
        lines.push('');

        // Show conversation highlights — user messages and assistant summary
        const exchanges = [];
        for (const msg of messages) {
            let content = msg.content || '';
            content = content.replace(/<!--thinking-->[\s\S]*?<!--\/thinking-->\n?\n?/g, '').trim();
            if (!content) continue;

            if (msg.role === 'user') {
                const text = content.length > 200 ? content.slice(0, 200) + '...' : content;
                exchanges.push(`> **You:** ${text}`);
            } else if (msg.role === 'assistant') {
                // Take first 2 lines or 300 chars as summary
                const firstLines = content.split('\n').filter(Boolean).slice(0, 3).join(' ');
                const text = firstLines.length > 300 ? firstLines.slice(0, 300) + '...' : firstLines;
                exchanges.push(`> **Claude:** ${text}`);
            }
        }

        if (exchanges.length > 0) {
            lines.push('**Previous conversation:**');
            // Show last 6 exchanges max for readability
            const shown = exchanges.slice(-6);
            if (exchanges.length > 6) lines.push(`> _...${exchanges.length - 6} earlier messages omitted..._`);
            lines.push(...shown);
        }

        return lines.join('\n');
    }

    _buildForkContext(parentSession, messages) {
        const lines = [];
        lines.push(`# Context from previous session ${parentSession.id}`);
        lines.push(`Original task: ${parentSession.task || 'N/A'}`);
        lines.push(`Status: ${parentSession.status || 'unknown'}`);
        lines.push('');
        lines.push('## Conversation summary:');
        lines.push('');

        for (const msg of messages) {
            // Strip thinking blocks from assistant messages for cleaner context
            let content = msg.content || '';
            content = content.replace(/<!--thinking-->[\s\S]*?<!--\/thinking-->\n?\n?/g, '').trim();
            if (!content) continue;

            if (msg.role === 'user') {
                // Truncate long user messages
                const text = content.length > 500 ? content.slice(0, 500) + '...' : content;
                lines.push(`**User:** ${text}`);
            } else if (msg.role === 'assistant') {
                // Truncate long assistant responses
                const text = content.length > 1500 ? content.slice(0, 1500) + '...' : content;
                lines.push(`**Assistant:** ${text}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    async resumeSession(sessionId, followUp, imagePath = null, modelOverride = null) {
        const session = this.store.getSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.claude_session_id) throw new Error(`Session ${sessionId} has no Claude ID yet`);
        if (this.isRunning(sessionId)) throw new Error(`Session ${sessionId} is currently running.`);

        this.store.addMessage(sessionId, 'user', followUp);
        // Mid-session model switch: persist the override so this resume — and every later message — uses it.
        const updates = { status: 'running', thread_open: 1 };
        if (modelOverride && modelOverride !== session.model) updates.model = modelOverride;
        this.store.updateSession(sessionId, updates);
        const model = modelOverride || session.model || 'claude-opus-4-8';
        this._spawnResume(sessionId, session.claude_session_id, followUp, session.working_dir, session.cost_usd || 0, imagePath, model);
        return { sessionId };
    }

    stopSession(sessionId) {
        const entry = this.processes.get(sessionId);
        const session = this.store.getSession(sessionId);
        const costUsd = entry?.costUsd || session?.cost_usd || 0;
        if (entry?.proc) { try { entry.proc.kill(); } catch (_) { } }
        this.store.updateSession(sessionId, { status: 'stopped' });
        this.processes.delete(sessionId);
        return costUsd;
    }

    isRunning(sessionId) { return this.processes.has(sessionId); }
    getLastOutput(sessionId) { return this.processes.get(sessionId)?.lastOutput || null; }

    async planSession(userPhone, task, workingDir, model = 'claude-opus-4-8') {
        const sessionId = `WA-plan-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, null, model);
        this.store.addMessage(sessionId, 'user', task);
        this._spawnPlan(sessionId, task, dir, model);
        return { sessionId };
    }

    // Role-based augmentation for a session: tester persona preamble + (when the
    // tester has no edit access) CLI flags that hard-disable file-editing tools.
    _roleAugment(sessionId) {
        try {
            const s = this.store.getSession(sessionId);
            if (!s || s.mode !== 'tester') return { preamble: '', extraArgs: [] };
            const canEdit = s.edit_access !== 0;
            const editLine = canEdit
                ? 'You MAY edit code and test files to add or run tests.'
                : 'READ-ONLY: you do NOT have code-edit access. Do not modify any files — produce test cases, run read-only checks, and report findings. File-editing tools are disabled.';
            // Use the `--flag=value` form (single token): --disallowedTools is variadic, so a
            // space-separated value would greedily swallow the trailing positional prompt.
            return {
                preamble: `${TESTER_PROMPT}\n${editLine}`,
                extraArgs: canEdit ? [] : [`--disallowedTools=${EDIT_TOOLS}`],
            };
        } catch { return { preamble: '', extraArgs: [] }; }
    }

    _spawnNew(sessionId, prompt, workingDir, imagePath = null, model = 'claude-opus-4-8') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const { preamble, extraArgs } = this._roleAugment(sessionId);
        const head = [KB_HINT, preamble].filter(Boolean).join('\n\n');
        const fullPrompt = fileRef ? `${head}\n\n${fileRef}\n\n${prompt}` : `${head}\n\n${prompt}`;
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, ...extraArgs, fullPrompt];
        console.log(`[Claude] NEW session ${sessionId} | model: ${model} | cwd: ${workingDir}${extraArgs.length ? ' | read-only' : ''}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnPlan(sessionId, prompt, workingDir, model = 'claude-opus-4-8') {
        const planPrefix = 'PLANNING MODE: Read the codebase and relevant knowledge base docs, then write a detailed step-by-step plan of the changes you would make. Do NOT modify any files. Output the plan as a numbered list, then stop.';
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, `${KB_HINT}\n\n${planPrefix}\n\nTask: ${prompt}`];
        console.log(`[Claude] PLAN session ${sessionId} | model: ${model} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnResume(sessionId, claudeSessionId, followUp, workingDir, baseCost = 0, imagePath = null, model = 'claude-opus-4-8') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        // Re-apply tester edit-gating on every turn (the persona was set when the fork
        // was created; the disallowed-tools flags must be passed on each resume).
        const { extraArgs } = this._roleAugment(sessionId);
        const fullFollowUp = fileRef ? `${fileRef}\n\n${followUp}` : followUp;
        const args = ['--resume', claudeSessionId, '--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, ...extraArgs, fullFollowUp];
        console.log(`[Claude] RESUME session ${sessionId} | model: ${model} | claude_id: ${claudeSessionId}${extraArgs.length ? ' | read-only' : ''}`);
        // Carry recovery context so we can fall back to a fresh summarised session
        // if the resume transcript overflows the model context ("Prompt is too long").
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, baseCost, {
            isResume: true,
            followUp,
            workingDir,
            model,
        });
    }

    // When --resume overflows the context window, start a FRESH Claude session
    // seeded with a summary of recent messages instead. Same session id, clean transcript.
    _recoverFromOverflow(sessionId, recovery) {
        const session = this.store.getSession(sessionId);
        if (!session) return;
        console.log(`[Claude] Session ${sessionId} overflowed on resume — recovering with summarised fresh session.`);
        const messages = this.store.getMessages(sessionId, 30);
        const summary = this._buildForkContext(session, messages);
        const prompt = `${summary}\n\n---\n\nThe previous conversation got too long to resume directly, so it has been summarised above. Continue from here.\n\nNew message:\n${recovery.followUp}`;
        // Clear the old claude_session_id so the new (fresh) one is captured on the result event.
        this.store.updateSession(sessionId, { claude_session_id: null, status: 'running' });
        this.emit('assistant_message', { sessionId, content: '_(Conversation was too long to resume — continuing with a summarised context.)_' });
        this._spawnNew(sessionId, prompt, recovery.workingDir, null, recovery.model);
    }

    _prepareFile(filePath, workingDir) {
        if (!filePath || !fs.existsSync(filePath)) return null;
        try {
            const ext = path.extname(filePath);
            const origName = path.basename(filePath);
            const destName = `context-file-${Date.now()}${ext}`;
            const dest = path.join(workingDir || config.DEFAULT_WORKING_DIR, destName);
            fs.copyFileSync(filePath, dest);
            // Keep the original upload in place — it's served at /api/uploads/<name>
            // and referenced in the chat history so the attachment stays visible.
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext.toLowerCase());
            return isImage
                ? `[Image attached — saved at: ${dest}. Please view/read this image as part of the task.]`
                : `[File attached (${origName}) — saved at: ${dest}. Please read/analyze this file as part of the task.]`;
        } catch (err) {
            console.error(`[Claude] Failed to prepare file: ${err.message}`);
            return null;
        }
    }

    _buildEnv(sessionId) {
        const env = { ...process.env };
        try {
            const session = this.store.getSession(sessionId);
            if (!session?.owner_id) return env;
            const user = this.store.getUserById?.(session.owner_id);
            if (!user) return env;
            const name = user.display_name || user.email?.split('@')[0] || user.phone || 'OliBot User';
            const email = user.email || `${(user.phone || user.id || 'user').toString().replace(/[^a-zA-Z0-9._-]/g, '')}@olibot.local`;
            env.GIT_AUTHOR_NAME = name;
            env.GIT_AUTHOR_EMAIL = email;
            env.GIT_COMMITTER_NAME = name;
            env.GIT_COMMITTER_EMAIL = email;
        } catch (err) {
            console.error(`[Claude] Failed to resolve git author for ${sessionId}: ${err.message}`);
        }
        return env;
    }

    _runPty(sessionId, bin, args, workingDir, baseCost = 0, recovery = null) {
        const entry = { proc: null, baseCost, costUsd: baseCost, inputTokens: 0, outputTokens: 0, lastOutput: '', lineBuffer: '', resultEmitted: false, recovery };
        this.processes.set(sessionId, entry);

        const proc = pty.spawn(bin, args, {
            name: 'xterm-color',
            cols: 1000000,
            rows: 50,
            cwd: workingDir || config.DEFAULT_WORKING_DIR,
            env: this._buildEnv(sessionId),
        });
        entry.proc = proc;

        proc.on('data', (raw) => {
            const text = raw.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
            entry.lastOutput += text;
            entry.lineBuffer += text;
            const lines = entry.lineBuffer.split('\n');
            entry.lineBuffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try { const event = JSON.parse(trimmed); this._handleEvent(sessionId, event, entry); } catch (_) { }
            }
        });

        proc.on('exit', (code) => {
            const exitCode = typeof code === 'number' ? code : 0;
            console.log(`[Claude] Session ${sessionId} exited (code ${exitCode})`);
            const remaining = entry.lineBuffer.trim();
            if (remaining && !entry.resultEmitted) {
                try { const event = JSON.parse(remaining); this._handleEvent(sessionId, event, entry); } catch (_) { }
            }

            // Context overflow on resume → recover with a summarised fresh session (once).
            const overflowed = /prompt is too long|input is too long|exceeds?.{0,20}context|too many tokens/i.test(entry.lastOutput || '');
            if (overflowed && entry.recovery?.isResume) {
                this.processes.delete(sessionId);
                this._recoverFromOverflow(sessionId, entry.recovery);
                return;
            }

            const status = exitCode === 0 ? 'completed' : 'failed';
            this.store.updateSession(sessionId, { status });
            this.processes.delete(sessionId);
            this.emit('session_end', { sessionId, code: exitCode, status, costUsd: entry.costUsd });
        });
    }

    _handleEvent(sessionId, event, entry) {
        const processCost = event.total_cost_usd ?? event.cost_usd ?? event.usage?.total_cost_usd;
        if (processCost != null && entry) {
            const totalSessionCost = entry.baseCost + processCost;
            if (totalSessionCost > entry.costUsd) {
                entry.costUsd = totalSessionCost;
                this.store.updateSession(sessionId, { cost_usd: totalSessionCost });
            }
        }

        // Track tokens from usage object
        const usage = event.usage;
        if (usage && entry) {
            const newInput = usage.input_tokens ?? usage.total_input_tokens ?? 0;
            const newOutput = usage.output_tokens ?? usage.total_output_tokens ?? 0;
            if (newInput > entry.inputTokens || newOutput > entry.outputTokens) {
                entry.inputTokens = Math.max(entry.inputTokens, newInput);
                entry.outputTokens = Math.max(entry.outputTokens, newOutput);
                this.store.updateSession(sessionId, { input_tokens: entry.inputTokens, output_tokens: entry.outputTokens });
            }
        }

        if (event.type === 'assistant' && event.message) {
            if (entry?.resultEmitted) return;
            // Collect thinking/tool-use summaries
            const thinking = this._extractThinking(event.message);
            if (thinking && entry) {
                if (!entry.thinkingLines) entry.thinkingLines = [];
                entry.thinkingLines.push(...thinking);
            }
            const content = this._extractText(event.message);
            if (content) {
                // Store with thinking prefix
                const thinkingBlock = entry?.thinkingLines?.length
                    ? `<!--thinking-->\n${entry.thinkingLines.join('\n')}\n<!--/thinking-->\n\n`
                    : '';
                this.store.upsertLastAssistantMessage(sessionId, thinkingBlock + content);
                const now = Date.now();
                if (!this._lastNotify[sessionId] || (now - this._lastNotify[sessionId]) > 10000) {
                    this._lastNotify[sessionId] = now;
                    this.emit('assistant_message', { sessionId, content: thinkingBlock + content });
                }
            } else if (thinking && thinking.length > 0) {
                // No text content yet but we have thinking — still update the message
                const thinkingBlock = `<!--thinking-->\n${entry.thinkingLines.join('\n')}\n<!--/thinking-->`;
                this.store.upsertLastAssistantMessage(sessionId, thinkingBlock);
                const now = Date.now();
                if (!this._lastNotify[sessionId] || (now - this._lastNotify[sessionId]) > 10000) {
                    this._lastNotify[sessionId] = now;
                    this.emit('assistant_message', { sessionId, content: thinkingBlock });
                }
            }
        }

        if (event.type === 'result') {
            if (entry?.resultEmitted) return;
            if (entry) entry.resultEmitted = true;
            if (event.session_id) {
                this.store.updateSession(sessionId, { claude_session_id: event.session_id });
                if (entry) entry.claudeSessionId = event.session_id;
                console.log(`[Claude] Session ${sessionId} → claude_session_id: ${event.session_id}`);
            }
            const currentCost = entry?.costUsd || entry?.baseCost || 0;
            const content = this._extractText(event.result || event.message);
            if (content) {
                // Prepend accumulated thinking to final result
                const thinkingBlock = entry?.thinkingLines?.length
                    ? `<!--thinking-->\n${entry.thinkingLines.join('\n')}\n<!--/thinking-->\n\n`
                    : '';
                this.store.upsertLastAssistantMessage(sessionId, thinkingBlock + content);
                this.emit('result', { sessionId, content: thinkingBlock + content, costUsd: currentCost });
            }
        }

        if (event.type === 'error') {
            const errorMsg = event.error || event.message || 'Unknown error';
            console.error(`[Claude] Session ${sessionId} error: ${errorMsg}`);
            this.emit('session_error', { sessionId, error: errorMsg });
            if (/401|invalid auth|authentication/i.test(errorMsg)) {
                this.emit('auth_error', { sessionId, error: errorMsg });
            }
        }
    }

    _extractText(msg) {
        if (!msg) return null;
        if (typeof msg === 'string') return msg.trim() || null;
        if (Array.isArray(msg.content)) {
            const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            return text || null;
        }
        if (typeof msg.content === 'string') return msg.content.trim() || null;
        if (msg.text) return msg.text.trim() || null;
        return null;
    }

    _extractThinking(msg) {
        if (!msg || !Array.isArray(msg.content)) return null;
        const lines = [];
        for (const block of msg.content) {
            if (block.type === 'tool_use') {
                const name = block.name || 'unknown';
                // Summarize tool use
                if (name === 'Read' || name === 'read_file') {
                    lines.push(`Reading ${block.input?.file_path || block.input?.path || 'file'}...`);
                } else if (name === 'Write' || name === 'write_file') {
                    lines.push(`Writing ${block.input?.file_path || block.input?.path || 'file'}...`);
                } else if (name === 'Edit' || name === 'edit_file') {
                    lines.push(`Editing ${block.input?.file_path || block.input?.path || 'file'}...`);
                } else if (name === 'Bash' || name === 'execute_bash') {
                    const cmd = block.input?.command || '';
                    lines.push(`Running: ${cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd}`);
                } else if (name === 'Grep' || name === 'Glob') {
                    lines.push(`Searching: ${block.input?.pattern || ''}...`);
                } else if (name === 'Agent') {
                    lines.push(`Spawning agent: ${block.input?.description || 'sub-task'}...`);
                } else {
                    lines.push(`Using ${name}...`);
                }
            } else if (block.type === 'thinking' && block.thinking) {
                // Claude thinking blocks — take first line as summary
                const firstLine = block.thinking.split('\n')[0].trim();
                if (firstLine) lines.push(firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine);
            }
        }
        return lines.length > 0 ? lines : null;
    }
}

export default ClaudeManager;
