import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import config from './config.js';
// orchestrator import removed — Claude prompt is now file-based (CLAUDE.md)
import {
    signJwt, requireAuth, optionalAuth, requireAdmin,
    sendWelcomeEmail, sendAccessRequestEmail, generatePassword
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp store for uploaded files
const pendingImages = new Map();
function storePendingImage(filePath) {
    const token = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingImages.set(token, filePath);
    setTimeout(() => { try { fs.unlinkSync(pendingImages.get(token)); } catch (_) { } pendingImages.delete(token); }, 5 * 60 * 1000);
    return token;
}
export { pendingImages };

export function startDashboard(store, messageHandler, port = 18790, wa = null, executionEngine = null, orchestrator = null, hashPasswordFn = null) {
    // hashPassword function — passed in from index.js so we don't import store-specific module
    const hashPassword = hashPasswordFn || ((plain) => {
        const salt = 'wa-engineer-salt-2025';
        return require('crypto').createHash('sha256').update(salt + plain).digest('hex');
    });
    const app = express();
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ strict: false }));
    app.use(cookieParser());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/sessions', express.static(path.join(__dirname, 'public')));

    // ── Auth ──────────────────────────────────────────────

    app.post('/api/auth/login', (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'email and password required' });
            const user = store.verifyPassword(email, password);
            if (!user) return res.status(401).json({ error: 'Invalid email or password' });
            const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role });
            res.cookie('wa_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('wa_token');
        res.json({ success: true });
    });

    app.get('/api/me', requireAuth, (req, res) => {
        const user = store.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ id: user.id, email: user.email, phone: user.phone, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role });
    });

    // ── Stats ───────────────────────────────────────────────

    app.get('/api/stats', optionalAuth, (req, res) => {
        try {
            const totalCost = store.getTotalCost();
            const activeSessions = store.getAllActiveSessions();
            const allSessions = store.countAllSessions();
            const allMessages = store.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
            const pendingRequests = req.user?.isAdmin ? store.countPendingRequests() : 0;
            res.json({ totalCost, activeCount: activeSessions.length, totalSessions: allSessions, totalMessages: allMessages, pendingRequests });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sessions ──────────────────────────────────────────────

    app.get('/api/sessions', requireAuth, (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            const showAll = store.getSetting('show_all_sessions') === 'true';
            const isAdmin = req.user.isAdmin || req.user.is_admin;
            let sessions, total;
            if (showAll || isAdmin) {
                sessions = store.getSessionsForUser(req.user.id, limit, offset);
                total = store.countAllSessions();
            } else {
                sessions = store.getOwnSessions(req.user.id, limit, offset);
                total = store.countOwnSessions(req.user.id);
            }
            res.json({ sessions, total, page, totalPages: Math.ceil(total / limit), showAllSessions: showAll || isAdmin });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/active', optionalAuth, (req, res) => {
        try { res.json(store.getAllActiveSessions()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/:id/messages', requireAuth, (req, res) => {
        try { res.json(store.getMessages(req.params.id, 100)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Available Claude models
    app.get('/api/models', requireAuth, (req, res) => {
        res.json([
            { id: 'opus', name: 'Opus 4.6', description: 'Most capable for complex work', default: true },
            { id: 'sonnet', name: 'Sonnet 4.6', description: 'Best for everyday tasks' },
            { id: 'haiku', name: 'Haiku 4.5', description: 'Fastest for quick answers' },
        ]);
    });

    // ── Request / Grant Access ─────────────────────────────────

    /** Any logged-in user can request access to a session */
    app.post('/api/sessions/:id/request-access', requireAuth, async (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const requester = store.getUserById(req.user.id);
            const { note } = req.body;

            const requestId = store.createAccessRequest(
                req.params.id, requester.id,
                requester.display_name, requester.email, note || ''
            );

            // Email all admins
            const admins = store.getAdmins();
            for (const admin of admins) {
                if (admin.email) {
                    await sendAccessRequestEmail(
                        admin.email, requester.display_name, requester.email,
                        req.params.id, session.task
                    ).catch(e => console.warn('[Auth] Email send failed:', e.message));
                }
            }
            res.json({ success: true, requestId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Admin approves or rejects a request */
    app.post('/api/admin/access-requests/:id/resolve', requireAuth, requireAdmin, (req, res) => {
        try {
            const { approve } = req.body;
            store.resolveAccessRequest(req.params.id, req.user.id, !!approve);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Get all pending requests (admin notification feed) */
    app.get('/api/admin/access-requests', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getPendingAccessRequests()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Grant access directly */
    app.post('/api/sessions/:id/grant-access', requireAuth, requireAdmin, (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId required' });
            store.addCollaborator(req.params.id, userId);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/:id/collaborators', requireAuth, (req, res) => {
        try { res.json(store.getCollaborators(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Admin: User Management ──────────────────────────────────

    app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getAllUsers()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { email, displayName, role, isAdmin } = req.body;
            if (!email) return res.status(400).json({ error: 'email is required' });

            // Check if user already exists
            const existing = store.getUserByEmail(email);
            if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

            const password = generatePassword();
            const passwordHash = hashPassword(password);
            const user = store.createUser({
                email: email.toLowerCase().trim(),
                displayName: displayName || email.split('@')[0],
                role: role || 'developer',
                isAdmin: isAdmin ? 1 : 0,
                passwordHash,
                createdBy: req.user.id,
            });

            // Send welcome email with password
            if (config.SMTP_USER) {
                await sendWelcomeEmail(user.email, user.display_name, password)
                    .catch(e => console.warn('[Auth] Welcome email failed:', e.message));
            }

            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
        try {
            if (req.params.id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
            store.deleteUser(req.params.id);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
        try {
            const user = store.getUserById(req.params.id);
            if (!user) return res.status(404).json({ error: 'User not found' });
            const password = generatePassword();
            store.updateUserPassword(user.id, hashPassword(password));
            if (config.SMTP_USER && user.email) {
                await sendWelcomeEmail(user.email, user.display_name, password)
                    .catch(e => console.warn('[Auth] Reset email failed:', e.message));
            }
            res.json({ success: true, message: 'Password reset and emailed to user' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Users (self) ────────────────────────────────────────────

    app.get('/api/users', requireAuth, (req, res) => {
        // Non-admins get a minimal list for sharing purposes
        try {
            const users = store.getAllUsers().map(u => ({ id: u.id, displayName: u.display_name, email: u.email, role: u.role }));
            res.json(users);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/users/link-phone', requireAuth, (req, res) => {
        try {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone required' });
            store.linkPhoneToUser(req.user.id, phone);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Web Chat ──────────────────────────────────────────────

    app.post('/api/sessions/start', requireAuth, async (req, res) => {
        try {
            const { text, model } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required' });
            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const startInstruction = /^(start fresh|new task|ignore previous)/i.test(text) ? text : `[start fresh] ${text}`;
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            const result = await messageHandler({ isWeb: true, phone: String(phone), text: startInstruction, pushName: req.user.displayName || 'Dashboard', imagePath, ownerId: req.user.id, model: model || 'opus' });
            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sessions/:id/stop', requireAuth, (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const sessionId = req.params.id;
            const costUsd = executionEngine.stopSession(sessionId);
            res.json({ success: true, costUsd });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sessions/:id/message', requireAuth, async (req, res) => {
        try {
            const { text } = req.body;
            const sessionId = req.params.id;
            if (!text) return res.status(400).json({ error: 'text is required' });
            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            // Check access: owner or collaborator
            const isOwner = session.owner_id === req.user.id;
            const isCollab = store.isCollaborator(sessionId, req.user.id);
            if (!isOwner && !isCollab && !req.user.isAdmin) return res.status(403).json({ error: 'You do not have access to this session. Request access first.' });
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            await messageHandler({ isWeb: true, phone: String(phone), text: `[resume ${sessionId}] ${text}`, pushName: req.user.displayName || 'Dashboard', imagePath });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sessions/:id/fork', requireAuth, async (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const parentId = req.params.id;
            const { text, model } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required — describe what the new session should do' });
            const phone = req.user.phone || req.user.email || req.user.id;
            const result = await executionEngine.forkSession(parentId, text, String(phone), req.user.id, model);
            res.json({ success: true, sessionId: result.sessionId, forkedFrom: result.forkedFrom });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Cron Jobs ─────────────────────────────────────────────

    app.get('/api/cron', requireAuth, requireAdmin, (req, res) => {
        try {
            const cronPath = path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_jobs.json');
            if (fs.existsSync(cronPath)) {
                res.json(JSON.parse(fs.readFileSync(cronPath, 'utf8')));
            } else {
                res.json([]);
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/cron', requireAuth, requireAdmin, (req, res) => {
        try {
            let { id, schedule, task, phone } = req.body;
            if (!id || !schedule || !task) return res.status(400).json({ error: 'id, schedule, task are required' });

            // Format ID properly
            id = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');

            const cronPath = path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_jobs.json');
            let jobs = [];
            if (fs.existsSync(cronPath)) {
                try { jobs = JSON.parse(fs.readFileSync(cronPath, 'utf8')); } catch (e) { }
            }
            if (!Array.isArray(jobs)) jobs = [];

            const existingIdx = jobs.findIndex(j => j.id === id);
            if (existingIdx >= 0) {
                jobs[existingIdx] = { id, schedule, task, phone: phone || 'system_cron' };
            } else {
                jobs.push({ id, schedule, task, phone: phone || 'system_cron' });
            }

            fs.writeFileSync(cronPath, JSON.stringify(jobs, null, 2));
            res.json({ success: true, message: 'Cron job saved successfully' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/cron/:id', requireAuth, requireAdmin, (req, res) => {
        try {
            const cronPath = path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_jobs.json');
            if (fs.existsSync(cronPath)) {
                try {
                    let jobs = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
                    if (Array.isArray(jobs)) {
                        jobs = jobs.filter(j => j.id !== req.params.id);
                        fs.writeFileSync(cronPath, JSON.stringify(jobs, null, 2));
                    }
                } catch (e) { }
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/cron-logs', requireAuth, requireAdmin, (req, res) => {
        try {
            const logsPath = path.join(config.DEFAULT_WORKING_DIR || process.cwd(), 'cron_logs.jsonl');
            if (fs.existsSync(logsPath)) {
                const logs = fs.readFileSync(logsPath, 'utf8').trim().split('\n').map(l => {
                    try { return JSON.parse(l); } catch (e) { return null; }
                }).filter(Boolean);
                res.json(logs.slice(-50).reverse());
            } else {
                res.json([]);
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── File Upload ─────────────────────────────────────────────

    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    // Serve uploaded files
    app.use('/api/uploads', express.static(uploadsDir));

    const uploadHandler = express.raw({ type: '*/*', limit: '50mb' });
    app.post('/api/upload-file', uploadHandler, (req, res) => {
        try {
            const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
            let origName = 'file';
            try { if (req.headers['x-file-name']) origName = decodeURIComponent(req.headers['x-file-name']); } catch (_) { }
            const safeName = origName.replace(/[^a-zA-Z0-9.\u0080-\uFFFF_-]/g, '_');
            const ext = path.extname(safeName) || '.' + (mimeType.split('/')[1]?.split(';')[0] || 'bin');
            const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            const filePath = path.join(uploadsDir, fileName);
            fs.writeFileSync(filePath, req.body);
            // Also store in pending map for Claude session use
            const token = storePendingImage(filePath);
            const url = `/api/uploads/${fileName}`;
            res.json({ success: true, token, url, fileName, mimeType });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/upload-image', uploadHandler, (req, res) => res.redirect(307, '/api/upload-file'));

    // ── Phone Management ──────────────────────────────────────────

    app.get('/api/phones', requireAuth, (req, res) => {
        try { res.json(store.getAllowedPhones()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/phones', requireAuth, requireAdmin, (req, res) => {
        try {
            const { phone, label, userId } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone is required' });
            store.addAllowedPhone(String(phone).trim(), label || '', userId || null);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.delete('/api/phones/:phone', requireAuth, requireAdmin, (req, res) => {
        try { store.removeAllowedPhone(req.params.phone); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/phones/:phone/ping', requireAuth, requireAdmin, async (req, res) => {
        try {
            if (!wa) return res.status(503).json({ error: 'WhatsApp not connected' });
            await wa.sendMessage(req.params.phone, `👋 You've been added to OliBot.`);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Speech-to-Text (Deepgram) ─────────────────────────────────

    const DEEPGRAM_API_KEY = 'a8b75fa07ad77e26a7866d995ed329553927767b';
    const audioUploadHandler = express.raw({ type: '*/*', limit: '25mb' });
    app.post('/api/transcribe', audioUploadHandler, async (req, res) => {
        try {
            const dgRes = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                    'Content-Type': req.headers['content-type'] || 'audio/webm',
                },
                body: req.body,
            });
            if (!dgRes.ok) {
                const errText = await dgRes.text();
                throw new Error(`Deepgram API error ${dgRes.status}: ${errText}`);
            }
            const data = await dgRes.json();
            const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
            res.json({ success: true, transcript });
        } catch (err) {
            console.error('[Deepgram] Transcription error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Workspace File Browser ───────────────────────────────────

    app.get('/api/workspace/files', requireAuth, (req, res) => {
        try {
            const baseDir = path.resolve(config.DEFAULT_WORKING_DIR);
            const targetDir = req.query.dir ? path.resolve(baseDir, req.query.dir) : baseDir;
            if (!targetDir.startsWith(baseDir)) return res.status(403).json({ error: 'Access denied' });
            if (!fs.existsSync(targetDir)) return res.json([]);
            const items = fs.readdirSync(targetDir, { withFileTypes: true });
            const list = items.map(item => {
                let size = 0, lastModified = 0;
                try { const s = fs.statSync(path.join(targetDir, item.name)); size = s.size; lastModified = s.mtimeMs; } catch (_) { }
                return { name: item.name, isDirectory: item.isDirectory(), size, lastModified, path: path.relative(baseDir, path.join(targetDir, item.name)).replace(/\\/g, '/') };
            }).sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));
            res.json(list);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/workspace/download', requireAuth, (req, res) => {
        try {
            const baseDir = path.resolve(config.DEFAULT_WORKING_DIR);
            const file = req.query.path;
            if (!file) return res.status(400).send('Missing file path');
            const targetPath = path.resolve(baseDir, file);
            if (!targetPath.startsWith(baseDir)) return res.status(403).send('Access denied');
            if (!fs.existsSync(targetPath)) return res.status(404).send('File not found');
            res.download(targetPath);
        } catch (err) { res.status(500).send(err.message); }
    });

    // ── System Prompts (Admin) ─────────────────────────────────

    // ── Claude System Prompt (CLAUDE.md) ───────────────────────────
    const claudeMdPath = path.join(config.DEFAULT_WORKING_DIR, 'CLAUDE.md');

    // GET the Claude system prompt (reads CLAUDE.md from disk)
    app.get('/api/admin/claude-prompt', requireAuth, requireAdmin, (req, res) => {
        try {
            const content = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
            res.json({ key: 'claude', prompt: content, path: claudeMdPath });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // PUT update the Claude system prompt (writes CLAUDE.md to disk)
    app.put('/api/admin/claude-prompt', requireAuth, requireAdmin, (req, res) => {
        try {
            const { prompt } = req.body;
            if (typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
            fs.writeFileSync(claudeMdPath, prompt, 'utf-8');
            res.json({ success: true, message: 'CLAUDE.md updated. New sessions will use the updated prompt.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Admin Settings ─────────────────────────────────────────
    app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getAllSettings()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key) return res.status(400).json({ error: 'key is required' });
            store.setSetting(key, String(value));
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Public endpoint — any authenticated user can check if sessions are shared
    app.get('/api/settings/visibility', requireAuth, (req, res) => {
        try {
            const val = store.getSetting('show_all_sessions');
            res.json({ showAllSessions: val === 'true' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sprints ────────────────────────────────────────────────

    app.get('/api/sprints', requireAuth, (req, res) => {
        try { res.json(store.getAllSprints()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sprints', requireAuth, (req, res) => {
        try {
            const { name, description, startDate, endDate } = req.body;
            if (!name) return res.status(400).json({ error: 'name is required' });
            const sprint = store.createSprint({ name, description, startDate, endDate, createdBy: req.user.id });
            wsBroadcast('sprint_created', { sprint });
            res.json(sprint);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/sprints/:id', requireAuth, (req, res) => {
        try {
            const allowed = ['name', 'description', 'status', 'start_date', 'end_date'];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }
            const sprint = store.updateSprint(req.params.id, updates);
            if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
            wsBroadcast('sprint_updated', { sprint });
            res.json(sprint);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/sprints/:id', requireAuth, (req, res) => {
        try {
            store.deleteSprint(req.params.id);
            wsBroadcast('sprint_deleted', { sprintId: req.params.id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Issues (Linear-like task board) ──────────────────────────

    app.get('/api/issues', requireAuth, (req, res) => {
        try { res.json(store.getAllIssues()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/issues', requireAuth, (req, res) => {
        try {
            const { title, description, priority, labels, forkSessionId, sprintId, assignedTo, type } = req.body;
            if (!title) return res.status(400).json({ error: 'title is required' });
            const issue = store.createIssue({ title, description, priority, labels, createdBy: req.user.id, forkSessionId: forkSessionId || null, sprintId: sprintId || null, assignedTo: assignedTo || null, type: type || 'task' });
            wsBroadcast('issue_created', { issue });
            res.json(issue);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/issues/:id', requireAuth, (req, res) => {
        try {
            const allowed = ['title', 'description', 'status', 'priority', 'labels', 'assigned_to', 'sort_order', 'sprint_id', 'type'];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }
            if (updates.status === 'completed') updates.completed_at = new Date().toISOString();
            const issue = store.updateIssue(req.params.id, updates);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });
            wsBroadcast('issue_updated', { issue });
            res.json(issue);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/issues/:id', requireAuth, (req, res) => {
        try {
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot delete issues' });
            store.deleteIssue(req.params.id);
            wsBroadcast('issue_deleted', { issueId: req.params.id });
            res.json({ success: true });
        }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/issues/stats', requireAuth, (req, res) => {
        try { res.json(store.countIssuesByStatus()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Autonomous Run (picks issues one by one) ─────────────────

    // In-memory state for autonomous runner
    const autonomousState = { running: false, currentIssueId: null, sessionId: null };

    app.get('/api/autonomous/status', requireAuth, (req, res) => {
        res.json(autonomousState);
    });

    app.post('/api/autonomous/start', requireAuth, async (req, res) => {
        try {
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot run issues' });
            if (autonomousState.running) return res.status(400).json({ error: 'Autonomous runner is already active' });
            autonomousState.running = true;

            // Support selective issue running — if issueIds provided, queue only those
            const issueIds = Array.isArray(req.body.issueIds) ? req.body.issueIds : null;
            if (issueIds && issueIds.length > 0) {
                autonomousState.queue = issueIds;
            }

            // Pick first issue — from queue if set, otherwise next todo
            const issue = issueIds && issueIds.length > 0
                ? store.getIssue(issueIds[0])
                : store.getNextTodoIssue();
            if (!issue) {
                autonomousState.running = false;
                autonomousState.queue = null;
                return res.json({ success: false, message: 'No issues to run' });
            }

            // Mark as in_progress
            store.updateIssue(issue.id, { status: 'in_progress' });
            autonomousState.currentIssueId = issue.id;

            // Start a session for this issue — fork from session if specified
            const phone = req.user.phone || req.user.email || req.user.id;
            const model = req.body.model || 'opus';
            const taskPrompt = `[Issue ${issue.id}] ${issue.title}\n\n${issue.description || 'No additional details.'}`;
            let result;
            if (issue.fork_session_id && executionEngine) {
                result = await executionEngine.forkSession(issue.fork_session_id, taskPrompt, String(phone), req.user.id, model);
            } else {
                result = await messageHandler({ isWeb: true, phone: String(phone), text: `[start fresh] ${taskPrompt}`, pushName: req.user.displayName || 'Autonomous', ownerId: req.user.id, model });
            }

            if (result?.sessionId) {
                autonomousState.sessionId = result.sessionId;
                store.updateIssue(issue.id, { session_id: result.sessionId });
            }
            wsBroadcast('autonomous_update', { ...autonomousState });
            res.json({ success: true, issueId: issue.id, sessionId: result?.sessionId });
        } catch (err) {
            autonomousState.running = false;
            autonomousState.currentIssueId = null;
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/autonomous/stop', requireAuth, (req, res) => {
        try {
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot stop runs' });
            if (autonomousState.sessionId && executionEngine) {
                try { executionEngine.stopSession(autonomousState.sessionId); } catch (_) { }
            }
            // Revert current issue to todo if still in_progress
            if (autonomousState.currentIssueId) {
                const issue = store.getIssue(autonomousState.currentIssueId);
                if (issue && issue.status === 'in_progress') {
                    store.updateIssue(autonomousState.currentIssueId, { status: 'todo' });
                }
            }
            autonomousState.running = false;
            autonomousState.currentIssueId = null;
            autonomousState.sessionId = null;
            autonomousState.queue = null;
            wsBroadcast('autonomous_update', { ...autonomousState });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Listen for session completions to auto-pick next issue
    if (executionEngine) {
        executionEngine.on('session_end', ({ sessionId, status }) => {
            if (!autonomousState.running || autonomousState.sessionId !== sessionId) return;

            // Mark current issue based on session outcome
            if (autonomousState.currentIssueId) {
                const newStatus = status === 'completed' ? 'completed' : 'question';
                store.updateIssue(autonomousState.currentIssueId, {
                    status: newStatus,
                    ...(newStatus === 'completed' ? { completed_at: new Date().toISOString() } : {}),
                });
            }

            // Pick next issue — from queue if set, otherwise next todo
            let next = null;
            if (autonomousState.queue && autonomousState.queue.length > 0) {
                // Remove completed issue from queue, pick next
                autonomousState.queue = autonomousState.queue.filter(id => id !== autonomousState.currentIssueId);
                if (autonomousState.queue.length > 0) {
                    next = store.getIssue(autonomousState.queue[0]);
                }
            } else {
                next = store.getNextTodoIssue();
            }
            if (!next) {
                console.log('[Autonomous] No more issues to run. Stopping runner.');
                autonomousState.running = false;
                autonomousState.currentIssueId = null;
                autonomousState.sessionId = null;
                autonomousState.queue = null;
                wsBroadcast('autonomous_update', { ...autonomousState });
                return;
            }

            // Start next issue
            store.updateIssue(next.id, { status: 'in_progress' });
            autonomousState.currentIssueId = next.id;

            const taskPrompt = `[Issue ${next.id}] ${next.title}\n\n${next.description || 'No additional details.'}`;
            const startNext = next.fork_session_id && executionEngine
                ? executionEngine.forkSession(next.fork_session_id, taskPrompt, 'system_autonomous', null, 'opus')
                : messageHandler({ isWeb: true, phone: 'system_autonomous', text: `[start fresh] ${taskPrompt}`, pushName: 'Autonomous Runner', ownerId: null, model: 'opus' });
            startNext.then(result => {
                    if (result?.sessionId) {
                        autonomousState.sessionId = result.sessionId;
                        store.updateIssue(next.id, { session_id: result.sessionId });
                    }
                })
                .catch(err => {
                    console.error('[Autonomous] Failed to start next issue:', err.message);
                    store.updateIssue(next.id, { status: 'question' });
                    autonomousState.running = false;
                    autonomousState.currentIssueId = null;
                    autonomousState.sessionId = null;
                });
        });
    }

    // ── SPA catch-all — serve index.html for any non-API route ──
    app.get('{*path}', (req, res) => {
        if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // ── WebSocket Server ────────────────────────────────────────
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });

    // Track connected clients
    const wsClients = new Set();

    wss.on('connection', (ws) => {
        wsClients.add(ws);
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('close', () => wsClients.delete(ws));
        ws.on('error', () => wsClients.delete(ws));
        // Send initial connection ack
        ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    // Heartbeat — drop dead connections every 30s
    setInterval(() => {
        for (const ws of wsClients) {
            if (!ws.isAlive) { ws.terminate(); wsClients.delete(ws); continue; }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30000);

    // Broadcast helper
    function wsBroadcast(type, payload) {
        const msg = JSON.stringify({ type, ...payload, timestamp: Date.now() });
        for (const ws of wsClients) {
            if (ws.readyState === 1) ws.send(msg);
        }
    }

    // Wire up Claude execution engine events → WebSocket
    if (executionEngine) {
        executionEngine.on('assistant_message', ({ sessionId, content }) => {
            wsBroadcast('assistant_message', { sessionId, content });
        });

        executionEngine.on('result', ({ sessionId, content, costUsd }) => {
            wsBroadcast('result', { sessionId, content, costUsd });
        });

        executionEngine.on('session_end', ({ sessionId, code, status, costUsd }) => {
            wsBroadcast('session_end', { sessionId, code, status, costUsd });
        });

        executionEngine.on('session_error', ({ sessionId, error }) => {
            wsBroadcast('session_error', { sessionId, error });
        });
    }

    // Expose broadcast for external use (issues, autonomous, etc.)
    app._wsBroadcast = wsBroadcast;

    server.listen(port, () => console.log(`[Dashboard] 🌐 Web Dashboard running on port ${port} (WebSocket: /ws)`));
}
