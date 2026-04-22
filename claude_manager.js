// ============================================================
// claude_manager.js — Spawns, resumes, and monitors Claude Code
// ============================================================

import pty from 'node-pty';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

const KB_HINT = `[Context: Knowledge Base is in Outline wiki. To search KB, run: curl -s -X POST ${config.OUTLINE_API_URL}/documents.search -H "Authorization: Bearer ${config.OUTLINE_API_KEY}" -H "Content-Type: application/json" -d '{"query":"<search term>","collectionId":"${config.OUTLINE_KB_COLLECTION_ID}"}' | python3 -c "import sys,json; [print(d['document']['title'],'\\n',d['document']['text'][:500]) for d in json.loads(sys.stdin.read()).get('data',[])]". To read a specific doc: curl -s -X POST ${config.OUTLINE_API_URL}/documents.info -H "Authorization: Bearer ${config.OUTLINE_API_KEY}" -H "Content-Type: application/json" -d '{"id":"<doc_id>"}'. To update a doc: curl -s -X POST ${config.OUTLINE_API_URL}/documents.update -H "Authorization: Bearer ${config.OUTLINE_API_KEY}" -H "Content-Type: application/json" -d '{"id":"<doc_id>","text":"<new content>"}'. To create a new KB doc: curl -s -X POST ${config.OUTLINE_API_URL}/documents.create -H "Authorization: Bearer ${config.OUTLINE_API_KEY}" -H "Content-Type: application/json" -d '{"title":"<title>","text":"<content>","collectionId":"${config.OUTLINE_KB_COLLECTION_ID}","publish":true}'. PRDs collection ID: ${config.OUTLINE_PRD_COLLECTION_ID}]`;


// --dangerously-skip-permissions cannot be used as root — use settings-based permissions instead
const IS_ROOT = process.getuid?.() === 0;
const SKIP_PERMS = IS_ROOT ? [] : ['--dangerously-skip-permissions'];

class ClaudeManager extends EventEmitter {
    constructor(sessionStore) {
        super();
        this.store = sessionStore;
        this.processes = new Map();
        this._lastNotify = {};
    }

    async startSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'claude-opus-4-7') {
        const sessionId = `WA-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, model);
        this.store.addMessage(sessionId, 'user', task);
        this._spawnNew(sessionId, task, dir, imagePath, model);
        return { sessionId };
    }

    async startAutonomousSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'claude-opus-4-7') {
        return this.startSession(userPhone, task, workingDir, imagePath, ownerId, model);
    }

    async forkSession(parentSessionId, task, userPhone, ownerId = null, model = null) {
        const parent = this.store.getSession(parentSessionId);
        if (!parent) throw new Error(`Session ${parentSessionId} not found`);

        const sessionId = `WA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const dir = parent.working_dir || config.DEFAULT_WORKING_DIR;
        const sessionModel = model || parent.model || 'claude-opus-4-7';

        // Build context summary from parent session's messages
        const parentMessages = this.store.getMessages(parentSessionId, 50);
        const contextSummary = this._buildForkContext(parent, parentMessages);

        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, sessionModel);

        // Build a user-visible summary for the forked session
        const visibleSummary = this._buildVisibleSummary(parent, parentMessages);
        this.store.addMessage(sessionId, 'system', visibleSummary);
        this.store.addMessage(sessionId, 'user', task);
        this.store.updateSession(sessionId, { status: 'running' });

        // Start a fresh session with parent context + new task
        const forkPrompt = `${contextSummary}\n\n---\n\nNew task (forked from session ${parentSessionId}):\n${task}`;
        this._spawnNew(sessionId, forkPrompt, dir, null, sessionModel);
        return { sessionId, forkedFrom: parentSessionId };
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

    async resumeSession(sessionId, followUp, imagePath = null) {
        const session = this.store.getSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.claude_session_id) throw new Error(`Session ${sessionId} has no Claude ID yet`);
        if (this.isRunning(sessionId)) throw new Error(`Session ${sessionId} is currently running.`);

        this.store.addMessage(sessionId, 'user', followUp);
        this.store.updateSession(sessionId, { status: 'running', thread_open: 1 });
        const model = session.model || 'claude-opus-4-7';
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

    async planSession(userPhone, task, workingDir, model = 'claude-opus-4-7') {
        const sessionId = `WA-plan-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, null, model);
        this.store.addMessage(sessionId, 'user', task);
        this._spawnPlan(sessionId, task, dir, model);
        return { sessionId };
    }

    _spawnNew(sessionId, prompt, workingDir, imagePath = null, model = 'claude-opus-4-7') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullPrompt = fileRef ? `${KB_HINT}\n\n${fileRef}\n\n${prompt}` : `${KB_HINT}\n\n${prompt}`;
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, fullPrompt];
        console.log(`[Claude] NEW session ${sessionId} | model: ${model} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnPlan(sessionId, prompt, workingDir, model = 'claude-opus-4-7') {
        const planPrefix = 'PLANNING MODE: Read the codebase and relevant knowledge base docs, then write a detailed step-by-step plan of the changes you would make. Do NOT modify any files. Output the plan as a numbered list, then stop.';
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, `${KB_HINT}\n\n${planPrefix}\n\nTask: ${prompt}`];
        console.log(`[Claude] PLAN session ${sessionId} | model: ${model} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnResume(sessionId, claudeSessionId, followUp, workingDir, baseCost = 0, imagePath = null, model = 'claude-opus-4-7') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullFollowUp = fileRef ? `${fileRef}\n\n${followUp}` : followUp;
        const args = ['--resume', claudeSessionId, '--print', '--model', model, '--output-format', 'stream-json', '--verbose', ...SKIP_PERMS, fullFollowUp];
        console.log(`[Claude] RESUME session ${sessionId} | model: ${model} | claude_id: ${claudeSessionId}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, baseCost);
    }

    _prepareFile(filePath, workingDir) {
        if (!filePath || !fs.existsSync(filePath)) return null;
        try {
            const ext = path.extname(filePath);
            const origName = path.basename(filePath);
            const destName = `context-file-${Date.now()}${ext}`;
            const dest = path.join(workingDir || config.DEFAULT_WORKING_DIR, destName);
            fs.copyFileSync(filePath, dest);
            try { fs.unlinkSync(filePath); } catch (_) { }
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext.toLowerCase());
            return isImage
                ? `[Image attached — saved at: ${dest}. Please view/read this image as part of the task.]`
                : `[File attached (${origName}) — saved at: ${dest}. Please read/analyze this file as part of the task.]`;
        } catch (err) {
            console.error(`[Claude] Failed to prepare file: ${err.message}`);
            return null;
        }
    }

    _runPty(sessionId, bin, args, workingDir, baseCost = 0) {
        const entry = { proc: null, baseCost, costUsd: baseCost, inputTokens: 0, outputTokens: 0, lastOutput: '', lineBuffer: '', resultEmitted: false };
        this.processes.set(sessionId, entry);

        const proc = pty.spawn(bin, args, {
            name: 'xterm-color',
            cols: 1000000,
            rows: 50,
            cwd: workingDir || config.DEFAULT_WORKING_DIR,
            env: process.env,
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
