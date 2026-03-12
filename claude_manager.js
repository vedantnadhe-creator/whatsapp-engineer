// ============================================================
// claude_manager.js — Spawns, resumes, and monitors Claude Code
// ============================================================

import pty from 'node-pty';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

const KB_HINT = `[Context: Knowledge Base is at ${config.KB_DIR} - check relevant .md files there if you need domain knowledge.]`;

class ClaudeManager extends EventEmitter {
    constructor(sessionStore) {
        super();
        this.store = sessionStore;
        this.processes = new Map();
        this._lastNotify = {};
    }

    async startSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'opus') {
        const sessionId = `WA-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, ownerId, model);
        this.store.addMessage(sessionId, 'user', task);
        this._spawnNew(sessionId, task, dir, imagePath, model);
        return { sessionId };
    }

    async startAutonomousSession(userPhone, task, workingDir, imagePath = null, ownerId = null, model = 'opus') {
        return this.startSession(userPhone, task, workingDir, imagePath, ownerId, model);
    }

    async resumeSession(sessionId, followUp, imagePath = null) {
        const session = this.store.getSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.claude_session_id) throw new Error(`Session ${sessionId} has no Claude ID yet`);
        if (this.isRunning(sessionId)) throw new Error(`Session ${sessionId} is currently running.`);

        this.store.addMessage(sessionId, 'user', followUp);
        this.store.updateSession(sessionId, { status: 'running', thread_open: 1 });
        const model = session.model || 'opus';
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

    async planSession(userPhone, task, workingDir, model = 'opus') {
        const sessionId = `WA-plan-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;
        this.store.createSession(sessionId, userPhone, task, null, dir, null, model);
        this.store.addMessage(sessionId, 'user', task);
        this._spawnPlan(sessionId, task, dir, model);
        return { sessionId };
    }

    _spawnNew(sessionId, prompt, workingDir, imagePath = null, model = 'opus') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullPrompt = fileRef ? `${KB_HINT}\n\n${fileRef}\n\n${prompt}` : `${KB_HINT}\n\n${prompt}`;
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', fullPrompt];
        console.log(`[Claude] NEW session ${sessionId} | model: ${model} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnPlan(sessionId, prompt, workingDir, model = 'opus') {
        const planPrefix = 'PLANNING MODE: Read the codebase and relevant knowledge base docs, then write a detailed step-by-step plan of the changes you would make. Do NOT modify any files. Output the plan as a numbered list, then stop.';
        const args = ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', `${KB_HINT}\n\n${planPrefix}\n\nTask: ${prompt}`];
        console.log(`[Claude] PLAN session ${sessionId} | model: ${model} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    _spawnResume(sessionId, claudeSessionId, followUp, workingDir, baseCost = 0, imagePath = null, model = 'opus') {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullFollowUp = fileRef ? `${fileRef}\n\n${followUp}` : followUp;
        const args = ['--resume', claudeSessionId, '--print', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', fullFollowUp];
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
        const entry = { proc: null, baseCost, costUsd: baseCost, lastOutput: '', lineBuffer: '', resultEmitted: false };
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

        if (event.type === 'assistant' && event.message) {
            if (entry?.resultEmitted) return;
            const content = this._extractText(event.message);
            if (content) {
                this.store.upsertLastAssistantMessage(sessionId, content);
                const now = Date.now();
                if (!this._lastNotify[sessionId] || (now - this._lastNotify[sessionId]) > 10000) {
                    this._lastNotify[sessionId] = now;
                    this.emit('assistant_message', { sessionId, content });
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
                this.store.upsertLastAssistantMessage(sessionId, content);
                this.emit('result', { sessionId, content, costUsd: currentCost });
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
}

export default ClaudeManager;
