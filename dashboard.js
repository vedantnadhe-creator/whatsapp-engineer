import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
    // Expire only the token→path mapping after 5 min. Do NOT delete the file —
    // it's served at /api/uploads/<name> and referenced in the chat history.
    setTimeout(() => { pendingImages.delete(token); }, 5 * 60 * 1000);
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

    // ── S3 Client (for PRD proxy) ─────────────────────────
    const s3 = new S3Client({
        region: process.env.OCI_REGION || 'ap-mumbai-1',
        endpoint: process.env.S3_ENDPOINT || 'https://bmv2bqg5gpcd.compat.objectstorage.ap-mumbai-1.oraclecloud.com',
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
        forcePathStyle: true,
    });
    const S3_BUCKET = process.env.S3_BUCKET_NAME || 'pl-uat-public-docs';
    const ALLOWED_EMAIL_DOMAIN = process.env.PRD_EMAIL_DOMAIN || 'pluginlive.com';

    // ── PRD Proxy (email-domain restricted) ─────────────
    app.get('/prd/:filename', optionalAuth, async (req, res) => {
        const email = req.user?.email || '';
        if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
            return res.status(403).send(`
<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{font-family:sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;padding:3rem;border:1px solid #333;border-radius:12px;max-width:400px}
h1{color:#ef4444;font-size:1.5rem;margin-bottom:1rem}p{color:#a3a3a3;font-size:0.9rem;line-height:1.6}
a{color:#60a5fa;text-decoration:none}</style></head>
<body><div class="box"><h1>Access Denied</h1>
<p>This document is restricted to <strong>@${ALLOWED_EMAIL_DOMAIN}</strong> accounts.</p>
<p style="margin-top:1rem"><a href="/sessions">Login with your org email →</a></p>
</div></body></html>`);
        }
        try {
            const key = `prds/${req.params.filename}`;
            const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
            res.setHeader('Content-Type', resp.ContentType || 'text/html');
            resp.Body.pipe(res);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return res.status(404).send('<h1>PRD not found</h1>');
            }
            res.status(500).send(`Error: ${err.message}`);
        }
    });

    // ── Auth ──────────────────────────────────────────────

    app.post('/api/auth/login', (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'email and password required' });
            const user = store.verifyPassword(email, password);
            if (!user) return res.status(401).json({ error: 'Invalid email or password' });
            const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role });
            res.cookie('wa_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: true, path: '/' });
            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role, canEdit: user.can_edit !== 0, sprintOnly: user.sprint_only === 1 } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('wa_token', { path: '/' });
        res.json({ success: true });
    });

    app.get('/api/me', requireAuth, (req, res) => {
        const user = store.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ id: user.id, email: user.email, phone: user.phone, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role, canEdit: user.can_edit !== 0, sprintOnly: user.sprint_only === 1 });
    });

    // ── Stats ───────────────────────────────────────────────

    app.get('/api/stats', optionalAuth, (req, res) => {
        try {
            const totalCost = store.getTotalCost();
            const totalTokens = store.getTotalTokens();
            const activeSessions = store.getAllActiveSessions();
            const allSessions = store.countAllSessions();
            const allMessages = store.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
            const pendingRequests = req.user?.isAdmin ? store.countPendingRequests() : 0;
            const billingMode = store.getSetting('claude_billing_mode') || 'api';
            res.json({
                totalCost,
                totalInputTokens: totalTokens.input,
                totalOutputTokens: totalTokens.output,
                billingMode,
                activeCount: activeSessions.length,
                totalSessions: allSessions,
                totalMessages: allMessages,
                pendingRequests,
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sessions ──────────────────────────────────────────────

    app.get('/api/sessions', requireAuth, (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            const q = (req.query.q || '').toString().trim();
            const showAll = store.getSetting('show_all_sessions') === 'true';
            const isAdmin = req.user.isAdmin || req.user.is_admin;
            let sessions, total;
            if (q) {
                if (showAll || isAdmin) {
                    sessions = store.searchSessionsForUser(req.user.id, q, limit, offset);
                    total = store.countSearchSessionsForUser(q);
                } else {
                    sessions = store.searchOwnSessions(req.user.id, q, limit, offset);
                    total = store.countSearchOwnSessions(req.user.id, q);
                }
            } else if (showAll || isAdmin) {
                sessions = store.getSessionsForUser(req.user.id, limit, offset);
                total = store.countAllSessions();
            } else {
                sessions = store.getOwnSessions(req.user.id, limit, offset);
                total = store.countOwnSessions(req.user.id);
            }
            // Attach bookmark status
            const bookmarks = store.getBookmarkedSessionIds(req.user.id);
            sessions = sessions.map(s => ({ ...s, bookmarked: bookmarks.has(s.id) }));
            res.json({ sessions, total, page, totalPages: Math.ceil(total / limit), showAllSessions: showAll || isAdmin });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sessions/:id/bookmark', requireAuth, (req, res) => {
        try {
            const bookmarked = store.toggleBookmark(req.user.id, req.params.id);
            res.json({ bookmarked });
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
            { id: 'claude-opus-4-8', name: 'Opus 4.8', description: 'Latest — most capable for complex work', default: true },
            { id: 'fable', name: 'Fable 5', description: 'Most capable for hardest, long-running tasks · ~2× faster than Opus but uses ~2× the tokens' },
            { id: 'claude-opus-4-7', name: 'Opus 4.7', description: 'Previous Opus generation' },
            { id: 'opus', name: 'Opus 4.6', description: 'Older Opus generation' },
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

    // ── Session share links ─────────────────────────────────────
    // Owner/admin creates a shareable link (token). Recipient exchanges it for collaborator access.
    const SHARE_LINK_TTL_DAYS = 7;
    const canManageShareLinks = (session, user) => session && (session.owner_id === user.id || user.isAdmin);

    app.post('/api/sessions/:id/share-links', requireAuth, (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (!canManageShareLinks(session, req.user)) return res.status(403).json({ error: 'Only the session owner or an admin can create share links' });
            const token = crypto.randomBytes(24).toString('base64url');
            const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
            const link = store.createShareLink({
                sessionId: session.id,
                token,
                createdBy: req.user.id,
                permission: 'write',
                expiresAt,
            });
            res.json({ link, token, expiresAt, sessionId: session.id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/:id/share-links', requireAuth, (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (!canManageShareLinks(session, req.user)) return res.status(403).json({ error: 'Only the session owner or an admin can view share links' });
            res.json(store.listShareLinks(session.id));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/sessions/:id/share-links/:linkId', requireAuth, (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (!canManageShareLinks(session, req.user)) return res.status(403).json({ error: 'Only the session owner or an admin can revoke share links' });
            const link = store.getShareLinkById(req.params.linkId);
            if (!link || link.session_id !== session.id) return res.status(404).json({ error: 'Share link not found' });
            store.revokeShareLink(link.id);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Redeem a share token — any authenticated user. Adds them as a collaborator and returns session id.
    app.post('/api/share/:token/redeem', requireAuth, (req, res) => {
        try {
            const link = store.getShareLinkByToken(req.params.token);
            if (!link) return res.status(404).json({ error: 'Invalid share link' });
            if (link.revoked_at) return res.status(410).json({ error: 'This share link has been revoked' });
            if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This share link has expired' });
            const session = store.getSession(link.session_id);
            if (!session) return res.status(404).json({ error: 'Session no longer exists' });
            // Owner doesn't need to redeem — short-circuit
            if (session.owner_id !== req.user.id) {
                store.addCollaborator(session.id, req.user.id);
                store.incrementShareLinkUse(link.id);
            }
            res.json({ sessionId: session.id, permission: link.permission || 'write' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Admin: User Management ──────────────────────────────────

    app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getAllUsers()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { email, displayName, role, isAdmin, canEdit, sprintOnly } = req.body;
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
                // Testers gate code-edit access; everyone else can edit by default.
                canEdit: canEdit === undefined ? 1 : (canEdit ? 1 : 0),
                // Sprint-only is a tester scope; ignored (0) for non-testers.
                sprintOnly: role === 'tester' && sprintOnly ? 1 : 0,
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

    // Update a user's role / admin / code-edit access (Users settings panel).
    app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
        try {
            const user = store.getUserById(req.params.id);
            if (!user) return res.status(404).json({ error: 'User not found' });
            const { role, isAdmin, canEdit, sprintOnly } = req.body;
            const updated = store.updateUser(user.id, {
                ...(role !== undefined ? { role } : {}),
                ...(isAdmin !== undefined ? { isAdmin: !!isAdmin } : {}),
                ...(canEdit !== undefined ? { canEdit: !!canEdit } : {}),
                ...(sprintOnly !== undefined ? { sprintOnly: !!sprintOnly } : {}),
            });
            res.json({ success: true, user: { id: updated.id, email: updated.email, role: updated.role, is_admin: updated.is_admin, can_edit: updated.can_edit, sprint_only: updated.sprint_only } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Users (self) ────────────────────────────────────────────

    app.get('/api/users', requireAuth, (req, res) => {
        // Non-admins get a minimal list for sharing purposes
        try {
            const users = store.getAllUsers().map(u => ({ id: u.id, displayName: u.display_name, email: u.email, role: u.role, isAdmin: u.is_admin, canEdit: u.can_edit, sprintOnly: u.sprint_only }));
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
            const { text, model, sprintId, type, labels, name, mode } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required' });
            // Mode is role-driven: design → designs repo, tester → tester persona/gating, else developer.
            const sessionMode = (mode === 'design' || mode === 'tester') ? mode : 'developer';
            const isDesign = sessionMode === 'design';
            const sessionWorkingDir = isDesign ? config.DESIGNS_DIR : null;
            // Testers' code-edit access comes from their user setting (JWT lacks can_edit → read from store).
            const testerEditAccess = sessionMode === 'tester'
                ? (store.getUserById(req.user.id)?.can_edit !== 0)
                : undefined;
            const allowedTypes = ['task', 'bug', 'feature', 'improvement'];
            const sessionType = allowedTypes.includes(type) ? type : null;
            if (!sessionType) return res.status(400).json({ error: 'type is required (task, bug, feature, improvement)' });
            const tagList = Array.isArray(labels)
                ? labels.map(l => String(l).trim()).filter(Boolean)
                : (typeof labels === 'string' ? labels.split(',').map(l => l.trim()).filter(Boolean) : []);

            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const startInstruction = /^(start fresh|new task|ignore previous)/i.test(text) ? text : `[start fresh] ${text}`;
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            const result = await messageHandler({ isWeb: true, phone: String(phone), text: startInstruction, pushName: req.user.displayName || 'Dashboard', imagePath, ownerId: req.user.id, model: model || 'claude-opus-4-8', workingDir: sessionWorkingDir, mode: sessionMode, editAccess: testerEditAccess });
            // Attach sprint + type + tags + name and auto-create a session task issue
            if (result?.sessionId) {
                const sessionName = (typeof name === 'string' && name.trim())
                    ? name.trim().slice(0, 120)
                    : text.replace(/^\[start fresh\]\s*/i, '').trim().slice(0, 60);
                store.updateSession(result.sessionId, {
                    sprint_id: sprintId || null,
                    type: sessionType,
                    labels: tagList,
                    name: sessionName,
                    mode: sessionMode,
                    ...(sessionMode === 'tester' ? { edit_access: testerEditAccess ? 1 : 0 } : {}),
                });
                const cleanTask = text.replace(/^\[start fresh\]\s*/i, '').trim();
                const issue = store.createIssue({
                    title: cleanTask,
                    description: `Auto-created from session ${result.sessionId}`,
                    priority: 'medium',
                    labels: ['session', ...tagList],
                    createdBy: req.user.id,
                    sprintId: sprintId || null,
                    type: sessionType,
                    category: 'chat',
                });
                // Link session to the issue
                if (issue) {
                    store.updateIssue(issue.id, { session_id: result.sessionId });
                    wsBroadcast('issue_created', { issue });
                }
            }
            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Rename session
    app.put('/api/sessions/:id/name', requireAuth, (req, res) => {
        try {
            const sessionId = req.params.id;
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const isOwner = session.owner_id === req.user.id;
            const isCollab = store.isCollaborator(sessionId, req.user.id);
            if (!isOwner && !isCollab && !req.user.isAdmin) {
                return res.status(403).json({ error: 'You do not have access to rename this session' });
            }
            const raw = (req.body?.name ?? '').toString().trim();
            const name = raw ? raw.slice(0, 120) : null;
            store.updateSession(sessionId, { name });
            res.json({ success: true, name });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Delete session — admin only. Removes the session and all its messages/links/requests
    app.delete('/api/sessions/:id', requireAuth, requireAdmin, (req, res) => {
        try {
            const sessionId = req.params.id;
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            // Stop it first if it's still running
            if (executionEngine && executionEngine.isRunning?.(sessionId)) {
                try { executionEngine.stopSession(sessionId); } catch (_) { }
            }
            store.deleteSession(sessionId);
            wsBroadcast('session_deleted', { sessionId });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Update session sprint mapping
    app.put('/api/sessions/:id/sprint', requireAuth, (req, res) => {
        try {
            const { sprintId } = req.body;
            store.updateSession(req.params.id, { sprint_id: sprintId || null });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Mark session as done — sends completion workflow message to Claude
    app.post('/api/sessions/:id/mark-done', requireAuth, async (req, res) => {
        try {
            const sessionId = req.params.id;
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const completionMessage = `The task is complete. Please finalize this work by doing the following steps in order:
1. Run the code-reviewer skill (/requesting-code-review) to review all changes made in this session
2. If the review passes, commit all changes with a descriptive commit message
3. Push the code to GitHub
4. Deploy to UAT using the /uat-deployment skill
5. Mark any related issues as done

Do NOT ask for confirmation — proceed through each step automatically. If any step fails, report the error and continue with the remaining steps.`;

            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;

            if (session.status === 'running') {
                // Session is running — send as a follow-up message
                await messageHandler({ isWeb: true, phone: String(phone), text: `[resume ${sessionId}] ${completionMessage}`, pushName: req.user.displayName || 'Dashboard' });
            } else {
                // Session is stopped — resume it with the completion message
                await messageHandler({ isWeb: true, phone: String(phone), text: `[resume ${sessionId}] ${completionMessage}`, pushName: req.user.displayName || 'Dashboard' });
            }

            res.json({ success: true });
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
            // Testers cannot chat directly on a dev/design session shared with them — they must
            // fork it into their own tester session via "Test it" first.
            if (req.user.role === 'tester' && session.mode !== 'tester') {
                return res.status(403).json({ error: 'Testers cannot chat on this session directly — use "Test it" to start a tester session.', code: 'TESTER_MUST_FORK' });
            }
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
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            const result = await executionEngine.forkSession(parentId, text, String(phone), req.user.id, model, { imagePath });
            // If the parent session is part of a sprint feature, file the fork as a subtask of that feature.
            if (result?.sessionId) {
                const parentFeature = store.getFeatureBySession(parentId);
                if (parentFeature) {
                    const sub = store.createIssue({
                        title: text.toString().slice(0, 120),
                        createdBy: req.user.id,
                        sprintId: parentFeature.sprint_id,
                        parentIssueId: parentFeature.id,
                        sessionId: result.sessionId,
                        platform: parentFeature.platform || '',
                        type: 'task',
                    });
                    store.updateIssue(sub.id, { dev_status: 'in_progress', status: 'in_progress' });
                    store.updateSession(result.sessionId, { sprint_id: parentFeature.sprint_id || null });
                    wsBroadcast('issue_created', { issue: store.getIssue(sub.id) });
                }
            }
            res.json({ success: true, sessionId: result.sessionId, forkedFrom: result.forkedFrom });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Merge 2+ sessions into one new session. Each parent is compacted and combined
    // (same context machinery as fork), then a fresh merged session is spawned.
    app.post('/api/sessions/merge', requireAuth, async (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const { sessionIds, text, model } = req.body;
            if (!Array.isArray(sessionIds) || sessionIds.filter(Boolean).length < 2) {
                return res.status(400).json({ error: 'Provide at least 2 sessionIds to merge' });
            }
            // Only merge sessions the user can see (own/admin), to avoid leaking context.
            const selfPhone = req.user.phone || req.user.email || req.user.id;
            const visible = sessionIds.filter(id => {
                const s = store.getSession(id);
                return s && (req.user.isAdmin || s.owner_id === req.user.id || s.user_phone === selfPhone);
            });
            if (visible.length < 2) return res.status(403).json({ error: 'You can only merge your own sessions (need at least 2).' });
            const task = (typeof text === 'string' && text.trim())
                ? text.trim()
                : 'Continue from the combined context of the merged sessions.';
            const phone = req.user.phone || req.user.email || req.user.id;
            const result = await executionEngine.mergeSessions(visible, task, String(phone), req.user.id, model || null);
            res.json({ success: true, sessionId: result.sessionId, mergedFrom: result.mergedFrom });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Tester "Test it": fork a shared session into a tester-mode session the tester can chat in.
    // Edit access on the fork is governed by the tester's user setting (users.can_edit).
    app.post('/api/sessions/:id/test-fork', requireAuth, async (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const parentId = req.params.id;
            const parent = store.getSession(parentId);
            if (!parent) return res.status(404).json({ error: 'Session not found' });
            const phone = req.user.phone || req.user.email || req.user.id;
            const editAccess = store.getUserById(req.user.id)?.can_edit !== 0;
            const task = (typeof req.body?.text === 'string' && req.body.text.trim())
                ? req.body.text.trim()
                : `Run a QA pass on the work in session ${parentId}. Review what changed by reading the code/diff and session history yourself, infer the expected behavior, then propose and run test cases and report findings. Do not pause to ask for a PRD or acceptance criteria — proceed autonomously.`;
            const result = await executionEngine.forkSession(parentId, task, String(phone), req.user.id, req.body?.model || null, { mode: 'tester', editAccess });
            res.json({ success: true, sessionId: result.sessionId, forkedFrom: result.forkedFrom, editAccess });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Agents ────────────────────────────────────────────────

    const AGENTS_DIR = path.join(__dirname, 'agents');

    function loadAgent(agentId) {
        const safeId = String(agentId).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeId) return null;
        const dir = path.join(AGENTS_DIR, safeId);
        const metaPath = path.join(dir, 'agent.json');
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const workflowPath = path.join(dir, meta.workflow_file || 'workflow.md');
        const statePath = path.join(dir, meta.state_file || 'state.json');
        const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';
        let state = {};
        if (fs.existsSync(statePath)) {
            try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { state = {}; }
        }
        return { ...meta, dir, workflow, state, workflowPath, statePath };
    }

    function listAgents() {
        if (!fs.existsSync(AGENTS_DIR)) return [];
        return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => loadAgent(d.name))
            .filter(Boolean)
            .map(a => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, model: a.model, version: a.version, lastRunAt: a.state?.last_run_at || null }));
    }

    app.get('/api/agents', requireAuth, (req, res) => {
        try { res.json({ agents: listAgents() }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/agents/:id', requireAuth, (req, res) => {
        try {
            const agent = loadAgent(req.params.id);
            if (!agent) return res.status(404).json({ error: 'Agent not found' });
            res.json({ agent });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/agents/:id/run', requireAuth, async (req, res) => {
        try {
            const agent = loadAgent(req.params.id);
            if (!agent) return res.status(404).json({ error: 'Agent not found' });

            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const userOverride = (req.body?.note || '').toString().trim();
            const stateBlock = `## Current agent state (from ${agent.statePath})\n\n\`\`\`json\n${JSON.stringify(agent.state, null, 2)}\n\`\`\``;
            const triggeredBy = req.user.displayName || req.user.email || req.user.id;
            const prompt = [
                `[start fresh] You are running the **${agent.name}** agent (${agent.id}).`,
                `Triggered by: ${triggeredBy} on ${new Date().toISOString()}`,
                userOverride ? `\nUser note for this run: ${userOverride}` : '',
                `\n${stateBlock}`,
                `\n---\n\n${agent.workflow}`,
            ].filter(Boolean).join('\n');

            const result = await messageHandler({
                isWeb: true,
                phone: String(phone),
                text: prompt,
                pushName: req.user.displayName || 'Agent',
                ownerId: req.user.id,
                model: agent.model || 'claude-opus-4-8',
            });

            if (result?.sessionId) {
                store.updateSession(result.sessionId, {
                    type: agent.type || 'task',
                    name: `${agent.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
                    labels: ['agent', agent.id],
                });
            }
            res.json({ success: true, sessionId: result?.sessionId, agentId: agent.id });
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

    // ── Learnings (LEARNINGS.md — self-improving knowledge) ─────
    const learningsPath = path.join(config.DEFAULT_WORKING_DIR, 'LEARNINGS.md');

    app.get('/api/admin/learnings', requireAuth, requireAdmin, (req, res) => {
        try {
            const content = fs.existsSync(learningsPath) ? fs.readFileSync(learningsPath, 'utf-8') : '';
            res.json({ content, path: learningsPath });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/learnings', requireAuth, requireAdmin, (req, res) => {
        try {
            const { content } = req.body;
            if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
            fs.writeFileSync(learningsPath, content, 'utf-8');
            res.json({ success: true, message: 'LEARNINGS.md updated.' });
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

    // ── Claude Auth ─────────────────────────────────────────────
    let pendingAuthProc = null;

    app.get('/api/claude/auth-status', requireAuth, async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            const raw = execSync(`${config.CLAUDE_BIN} auth status 2>&1`, { timeout: 10000, encoding: 'utf8' });
            try {
                const status = JSON.parse(raw.trim());
                res.json({ ...status, raw: null });
            } catch {
                const loggedIn = /logged.?in/i.test(raw);
                res.json({ loggedIn, raw: raw.trim() });
            }
        } catch (err) {
            res.json({ loggedIn: false, raw: err.message });
        }
    });

    app.post('/api/claude/auth-start', requireAuth, requireAdmin, async (req, res) => {
        try {
            if (pendingAuthProc) { try { pendingAuthProc.kill(); } catch {} pendingAuthProc = null; }
            const { spawn } = await import('child_process');
            const proc = spawn(config.CLAUDE_BIN, ['auth', 'login', '--claudeai'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, TERM: 'dumb' },
            });
            pendingAuthProc = proc;
            let output = '';
            const urlPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timed out waiting for auth URL')), 30000);
                const onData = (chunk) => {
                    output += chunk.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
                    const urlMatch = output.match(/(https:\/\/[^\s]+)/);
                    if (urlMatch) { clearTimeout(timeout); resolve(urlMatch[1]); }
                };
                proc.stdout.on('data', onData);
                proc.stderr.on('data', onData);
                proc.on('exit', () => { clearTimeout(timeout); reject(new Error('Process exited before URL was found')); });
            });
            const authUrl = await urlPromise;
            res.json({ success: true, authUrl });
        } catch (err) {
            pendingAuthProc = null;
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/claude/auth-complete', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { token } = req.body;
            if (!token) return res.status(400).json({ error: 'token is required' });
            if (!pendingAuthProc) return res.status(400).json({ error: 'No pending auth session. Click Reconnect first.' });
            const proc = pendingAuthProc;
            pendingAuthProc = null;
            const resultPromise = new Promise((resolve) => {
                let output = '';
                const onData = (chunk) => { output += chunk.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''); };
                proc.stdout.on('data', onData);
                proc.stderr.on('data', onData);
                proc.on('exit', (code) => resolve({ code, output }));
                setTimeout(() => { try { proc.kill(); } catch {} resolve({ code: -1, output }); }, 15000);
            });
            proc.stdin.write(token.trim() + '\n');
            const { code, output } = await resultPromise;
            const success = code === 0 || /success|authenticated|logged in/i.test(output);
            res.json({ success, output: output.trim() });
        } catch (err) {
            pendingAuthProc = null;
            res.status(500).json({ error: err.message });
        }
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

    // Sprint changelog — get issues (with linked session info) for a sprint
    app.get('/api/sprints/:id/changelog', requireAuth, (req, res) => {
        try {
            const sprint = store.getSprint(req.params.id);
            if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
            const issues = store.getIssuesBySprint(req.params.id);

            // Enrich each issue with its linked session summary if it has one
            const enrichedIssues = issues.map(i => {
                let sessionInfo = null;
                if (i.session_id) {
                    const session = store.getSession(i.session_id);
                    if (session) {
                        const msgs = store.getSessionSummaryMessages(i.session_id, 30);
                        const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
                        sessionInfo = {
                            id: session.id,
                            task: session.task,
                            status: session.status,
                            summary: lastAssistant?.content?.slice(0, 500) || '',
                        };
                    }
                }
                return {
                    id: i.id,
                    title: i.title,
                    description: i.description,
                    status: i.status,
                    priority: i.priority,
                    type: i.type || 'task',
                    assignee_name: i.assignee_name,
                    creator_name: i.creator_name,
                    session_id: i.session_id,
                    session: sessionInfo,
                    created_at: i.created_at,
                };
            });

            res.json({ sprint, issues: enrichedIssues });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Request summary from an issue's linked session
    app.post('/api/issues/:id/request-summary', requireAuth, async (req, res) => {
        try {
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });
            if (!issue.session_id) return res.status(400).json({ error: 'Issue has no linked session' });

            const session = store.getSession(issue.session_id);
            if (!session) return res.status(404).json({ error: 'Linked session not found' });

            const summaryPrompt = `Provide a concise summary of everything that was done in this session for issue "${issue.title}". Include:
- What was implemented or changed
- Key files modified
- Any bugs fixed
- Current status of the work

Keep it to 3-5 bullet points, be specific about what changed. Do NOT start any new work.`;

            const phone = req.user.phone || req.user.email || req.user.id;
            await messageHandler({ isWeb: true, phone: String(phone), text: `[resume ${issue.session_id}] ${summaryPrompt}`, pushName: req.user.displayName || 'Dashboard' });

            res.json({ success: true, sessionId: issue.session_id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Get issue's linked session status + last response
    app.get('/api/issues/:id/last-response', requireAuth, (req, res) => {
        try {
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });
            if (!issue.session_id) return res.json({ issueId: req.params.id, status: 'no_session', lastResponse: '' });

            const session = store.getSession(issue.session_id);
            if (!session) return res.json({ issueId: req.params.id, status: 'no_session', lastResponse: '' });

            const msgs = store.getSessionSummaryMessages(issue.session_id, 10);
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');

            res.json({
                issueId: req.params.id,
                sessionId: issue.session_id,
                status: session.status,
                lastResponse: lastAssistant?.content || '',
                lastTimestamp: lastAssistant?.timestamp || null,
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Generate changelog from issue summaries — starts new interactive Claude session
    app.post('/api/sprints/:id/generate-changelog', requireAuth, async (req, res) => {
        try {
            const sprint = store.getSprint(req.params.id);
            if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
            const { summaries = [] } = req.body; // [{ issueId, title, type, summary, sessionId }]

            let issueEntries = summaries.map(s => {
                return `### ${s.type === 'bug' ? 'Bug Fix' : s.type === 'feature' ? 'Feature' : s.type === 'improvement' ? 'Improvement' : 'Task'}: ${s.title}
- Issue: ${s.issueId}${s.sessionId ? ` | Session: ${s.sessionId}` : ''}
- Summary:\n${s.summary || 'No summary available'}`;
            }).join('\n\n');

            const changelogPrompt = `You are generating a professional changelog for Sprint "${sprint.name}". I've collected summaries from each issue's linked session. Create a structured, detailed changelog.

## Sprint Details
- Name: ${sprint.name}
- Status: ${sprint.status}
- Start: ${sprint.start_date || 'N/A'} | End: ${sprint.end_date || 'N/A'}
- Total Issues: ${summaries.length}

## Issue Summaries
${issueEntries || 'No issues'}

## Your Task
Create a clean, professional changelog with:
1. **Sprint Overview** — 2-3 sentence summary of what was accomplished
2. **Changes** — Group by type (Features, Bug Fixes, Improvements, Tasks). For each:
   - **[Issue: <ID>] <title>** — with linked session ID if available
   - Bullet points of what was implemented/changed
   - Status indicator
3. **Summary Table** — All issues with final status in a markdown table
4. **Notable Highlights** — Key achievements or important fixes

Format as clean Markdown. Use issue IDs like [Issue: ISS-xxxxx] and session IDs like [Session: WA-xxxxx] so they are identifiable.
The user may ask follow-up questions about the changelog — answer based on the data provided above.`;

            const phone = req.user.phone || req.user.email || req.user.id;
            const result = await messageHandler({ isWeb: true, phone: String(phone), text: `[start fresh] ${changelogPrompt}`, pushName: req.user.displayName || 'Dashboard', ownerId: req.user.id, model: 'sonnet' });

            // Map the new changelog session to the same sprint
            if (result?.sessionId) {
                store.updateSession(result.sessionId, { sprint_id: req.params.id });
                // Create an issue for the changelog session
                const issue = store.createIssue({
                    title: `Changelog: ${sprint.name}`,
                    description: `Auto-generated changelog for sprint "${sprint.name}"`,
                    priority: 'low',
                    labels: ['changelog'],
                    createdBy: req.user.id,
                    sprintId: req.params.id,
                    type: 'task',
                    category: 'chat',
                });
                if (issue) {
                    store.updateIssue(issue.id, { session_id: result.sessionId });
                    wsBroadcast('issue_created', { issue });
                }
            }

            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Issues (Linear-like task board) ──────────────────────────

    app.get('/api/issues', requireAuth, (req, res) => {
        try { res.json(store.getAllIssues()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/issues', requireAuth, (req, res) => {
        try {
            const { title, description, priority, labels, forkSessionId, sprintId, assignedTo, type, mode, platform, qaOwner, parentIssueId, sessionId, deadline } = req.body;
            if (!title) return res.status(400).json({ error: 'title is required' });
            // Design issues: explicit mode from client, else default by creator's role (designers make design issues).
            const issueMode = (mode === 'design' || mode === 'developer')
                ? mode
                : (req.user.role === 'designer' ? 'design' : 'developer');
            // A subtask inherits its parent's sprint so it lives under the same feature.
            const parent = parentIssueId ? store.getIssue(parentIssueId) : null;
            const issue = store.createIssue({ title, description, priority, labels, createdBy: req.user.id, forkSessionId: forkSessionId || null, sprintId: parent ? parent.sprint_id : (sprintId || null), assignedTo: assignedTo || null, type: type || 'task', mode: issueMode, platform: parent ? parent.platform : (platform || ''), qaOwner: qaOwner || '', parentIssueId: parentIssueId || null, sessionId: sessionId || null, deadline: deadline || null });
            wsBroadcast('issue_created', { issue });

            // Notify assignee
            if (assignedTo) {
                const assignee = store.getUserById(assignedTo);
                const assignedCount = store.getAllIssues().filter(i => i.assigned_to === assignedTo && i.status !== 'completed').length;
                wsBroadcast('issue_assigned', {
                    issue,
                    assigneeId: assignedTo,
                    assigneeName: assignee?.display_name || 'Someone',
                    assignedBy: req.user.displayName || req.user.email,
                    totalAssigned: assignedCount,
                });
            }

            res.json(issue);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/issues/:id', requireAuth, (req, res) => {
        try {
            const allowed = ['title', 'description', 'status', 'priority', 'labels', 'assigned_to', 'sort_order', 'sprint_id', 'type', 'stage', 'prd_url', 'design_session_id', 'qa_session_id',
                // Sprint board fields
                'platform', 'qa_owner', 'dev_status', 'dev_percent', 'deadline',
                'test_cases_count', 'test_cases_done_date', 'qa_status', 'open_bugs', 'critical_bugs', 'qa_comments', 'is_backlog'];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }
            if (updates.status === 'completed') updates.completed_at = new Date().toISOString();
            // Keep the kanban status in sync when a manager flips Dev Status on the sprint board.
            if (updates.dev_status !== undefined) {
                const map = { todo: 'todo', in_progress: 'in_progress', dev_completed: 'in_progress', done: 'completed' };
                updates.status = map[updates.dev_status] || updates.status || 'todo';
                if (updates.dev_status === 'done') {
                    updates.completed_at = new Date().toISOString();
                    if (updates.dev_percent === undefined) updates.dev_percent = 100;
                }
            }

            // Detect assignment change
            const oldIssue = updates.assigned_to !== undefined ? store.getIssue(req.params.id) : null;

            const issue = store.updateIssue(req.params.id, updates);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });
            wsBroadcast('issue_updated', { issue });

            // Notify assignee if assignment changed
            if (updates.assigned_to && updates.assigned_to !== oldIssue?.assigned_to) {
                const assignee = store.getUserById(updates.assigned_to);
                const assignedCount = store.getAllIssues().filter(i => i.assigned_to === updates.assigned_to && i.status !== 'completed').length;
                wsBroadcast('issue_assigned', {
                    issue,
                    assigneeId: updates.assigned_to,
                    assigneeName: assignee?.display_name || 'Someone',
                    assignedBy: req.user.displayName || req.user.email,
                    totalAssigned: assignedCount,
                });
            }

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

    // ── Sprint Board: start a dev session from a feature ──────────────
    // The linked dev session auto-flips the feature to "Dev Completed" ONLY after a real UAT deploy.
    // Everything else (general "I think it's done") stays manual — the dev sets the status themselves.
    const UAT_DEPLOY_MARKER = '[[UAT_DEPLOYED]]';

    function buildFeatureDevPrompt(issue, devTask) {
        const task = (devTask || '').trim();
        const lines = [`Title: ${issue.title}`];
        if (issue.description) lines.push(`Description: ${issue.description}`);
        lines.push('', task || '(No specific instruction typed — work from the title and description above.)');
        // Keep the auto "Dev Completed" hook working without bloating the prompt: one line.
        lines.push('', `Only on a real, successful UAT deploy: update the knowledge base, then print ${UAT_DEPLOY_MARKER} on its own line. Never print it otherwise.`);
        return lines.join('\n');
    }

    app.post('/api/issues/:id/start-session', requireAuth, async (req, res) => {
        try {
            // Testers can edit the sprint board but may not spawn dev sessions on its issues.
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot start sessions on sprint issues.' });
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Feature not found' });
            // If a dev session already exists for this feature, just return it.
            if (issue.session_id && store.getSession(issue.session_id)) {
                return res.json({ success: true, sessionId: issue.session_id, existing: true });
            }
            const model = req.body.model || 'claude-opus-4-8';
            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            const result = await messageHandler({ isWeb: true, phone: String(phone), text: buildFeatureDevPrompt(issue, req.body.text), pushName: req.user.displayName || 'Dashboard', ownerId: req.user.id, model, mode: 'developer', imagePath });
            if (result?.sessionId) {
                store.updateSession(result.sessionId, { sprint_id: issue.sprint_id || null, type: issue.type || 'feature', name: issue.title.slice(0, 120), mode: 'developer' });
                store.updateIssue(issue.id, { session_id: result.sessionId, dev_status: 'in_progress', status: 'in_progress' });
                const updated = store.getIssue(issue.id);
                wsBroadcast('issue_updated', { issue: updated });
            }
            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sprint Board: Subtasks (child issues of a feature) ────────────
    app.get('/api/issues/:id/subtasks', requireAuth, (req, res) => {
        try { res.json(store.getSubtasks(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Add an existing session to the sprint board — as a standalone feature, or as a subtask
    // of an existing feature (parentIssueId). The issue is linked to that session.
    app.post('/api/sessions/:id/to-issue', requireAuth, async (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const { sprintId, parentIssueId } = req.body;
            const parent = parentIssueId ? store.getIssue(parentIssueId) : null;
            const title = (session.name || session.task || 'Session').toString().slice(0, 120);
            const issue = store.createIssue({
                title,
                createdBy: req.user.id,
                sprintId: parent ? parent.sprint_id : (sprintId || null),
                parentIssueId: parentIssueId || null,
                sessionId: session.id,
                type: session.type || 'task',
                platform: parent ? parent.platform : '',
                // Already has a running/finished session → it's at least in progress.
                category: 'issue',
            });
            // Reflect that work is underway and link the sprint to the session.
            store.updateIssue(issue.id, { dev_status: 'in_progress', status: 'in_progress' });
            store.updateSession(session.id, { sprint_id: issue.sprint_id || null });
            const finalIssue = store.getIssue(issue.id);
            wsBroadcast('issue_created', { issue: finalIssue });
            res.json(finalIssue);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sprint Board: Bugs (per feature) ──────────────────────────────
    app.get('/api/issues/:id/bugs', requireAuth, (req, res) => {
        try { res.json(store.getBugsByIssue(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/issues/:id/bugs', requireAuth, (req, res) => {
        try {
            const { title, description, severity } = req.body;
            if (!title) return res.status(400).json({ error: 'title is required' });
            const bug = store.createBug({ issueId: req.params.id, title, description: description || '', severity: severity === 'critical' ? 'critical' : 'normal', createdBy: req.user.id });
            wsBroadcast('issue_updated', { issue: store.getIssue(req.params.id) });
            res.json(bug);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/bugs/:id', requireAuth, (req, res) => {
        try {
            const bug = store.updateBug(req.params.id, req.body || {});
            if (!bug) return res.status(404).json({ error: 'Bug not found' });
            wsBroadcast('issue_updated', { issue: store.getIssue(bug.issue_id) });
            res.json(bug);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/bugs/:id', requireAuth, (req, res) => {
        try {
            const bug = store.getBug(req.params.id);
            store.deleteBug(req.params.id);
            if (bug) wsBroadcast('issue_updated', { issue: store.getIssue(bug.issue_id) });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Send a bug to the dev for fixing. The dev chooses how (req.body.action):
    //   'fork' (default) — fork a NEW session off the feature's dev session to fix it in isolation.
    //   'send'           — add the bug as context to the feature's CURRENT dev session (no new session).
    app.post('/api/bugs/:id/fork', requireAuth, async (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const bug = store.getBug(req.params.id);
            if (!bug) return res.status(404).json({ error: 'Bug not found' });
            const issue = store.getIssue(bug.issue_id);
            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const model = req.body.model || 'claude-opus-4-8';
            const action = req.body.action === 'send' ? 'send' : 'fork';
            const fixPrompt = `Fix this bug found during QA of feature "${issue?.title || bug.issue_id}":\n\nBUG: ${bug.title}\n${bug.description || ''}\n\nReproduce it, find the root cause, fix it, and verify. ${bug.severity === 'critical' ? 'This is CRITICAL.' : ''}`;
            const hasLiveSession = issue?.session_id && store.getSession(issue.session_id);
            let result;
            if (action === 'send' && hasLiveSession) {
                // Add to the current dev session as a new message — keeps one session, full context.
                await messageHandler({ isWeb: true, phone: String(phone), text: `[resume ${issue.session_id}] ${fixPrompt}`, pushName: req.user.displayName || 'Dashboard' });
                result = { sessionId: issue.session_id };
            } else if (hasLiveSession) {
                // Fork a fresh session off the dev session.
                result = await executionEngine.forkSession(issue.session_id, fixPrompt, String(phone), req.user.id, model);
            } else {
                // No live dev session — start fresh.
                result = await messageHandler({ isWeb: true, phone: String(phone), text: `[start fresh] ${fixPrompt}`, pushName: req.user.displayName || 'Dashboard', ownerId: req.user.id, model, mode: 'developer' });
            }
            if (result?.sessionId) store.updateBug(bug.id, { fix_session_id: result.sessionId, status: 'fixing' });
            wsBroadcast('issue_updated', { issue: store.getIssue(bug.issue_id) });
            res.json({ success: true, sessionId: result?.sessionId, action });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sprint Board: a session's linked feature + lifecycle status (Workspace status control) ──
    app.get('/api/sessions/:id/feature', requireAuth, (req, res) => {
        try { res.json(store.getFeatureBySession(req.params.id) || null); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/sessions/:id/feature-status', requireAuth, (req, res) => {
        try {
            const status = req.body.status;
            if (!['in_progress', 'dev_completed', 'qa_pass'].includes(status)) return res.status(400).json({ error: 'invalid status' });
            const updated = store.setFeatureStatusBySession(req.params.id, status);
            if (!updated) return res.status(404).json({ error: 'No feature linked to this session' });
            wsBroadcast('issue_updated', { issue: updated });
            res.json(updated);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sprint Board: Test cases (per feature) ────────────────────────
    app.get('/api/issues/:id/test-cases', requireAuth, (req, res) => {
        try { res.json(store.getTestCasesByIssue(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/issues/:id/test-cases', requireAuth, (req, res) => {
        try {
            const { title, steps, expected, status } = req.body;
            if (!title) return res.status(400).json({ error: 'title is required' });
            const tc = store.createTestCase({ issueId: req.params.id, title, steps: steps || '', expected: expected || '', status: status || 'pending', source: 'manual', createdBy: req.user.id });
            wsBroadcast('issue_updated', { issue: store.getIssue(req.params.id) });
            res.json(tc);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/test-cases/:id', requireAuth, (req, res) => {
        try {
            const tc = store.updateTestCase(req.params.id, req.body || {});
            if (!tc) return res.status(404).json({ error: 'Test case not found' });
            res.json(tc);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/test-cases/:id', requireAuth, (req, res) => {
        try {
            const tc = store.getTestCase(req.params.id);
            store.deleteTestCase(req.params.id);
            if (tc) wsBroadcast('issue_updated', { issue: store.getIssue(tc.issue_id) });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Generate test cases by forking the feature's session from the bot (QA can also add manually).
    app.post('/api/issues/:id/generate-test-cases', requireAuth, async (req, res) => {
        try {
            if (!executionEngine) return res.status(500).json({ error: 'Execution engine not attached' });
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Feature not found' });
            const phone = req.body.phone || req.user.phone || req.user.email || req.user.id;
            const model = req.body.model || 'claude-opus-4-8';
            const tcPrompt = `Write a thorough set of QA test cases for feature "${issue.title}"${issue.platform ? ` (${issue.platform})` : ''}.\n${issue.description || ''}\n\nCover happy path, edge cases, and negative cases. For EACH test case output a line in EXACTLY this format so it can be imported:\nTESTCASE | <title> | <steps> | <expected result>\nDerive expected behavior from the PRD/knowledge base first, code only if needed.`;
            let result;
            if (issue.session_id && store.getSession(issue.session_id)) {
                result = await executionEngine.forkSession(issue.session_id, tcPrompt, String(phone), req.user.id, model);
            } else {
                result = await messageHandler({ isWeb: true, phone: String(phone), text: `[start fresh] ${tcPrompt}`, pushName: req.user.displayName || 'Dashboard', ownerId: req.user.id, model, mode: 'developer' });
            }
            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Sprint progress (completion % + rollups) for the board header.
    app.get('/api/sprints/:id/progress', requireAuth, (req, res) => {
        try { res.json(store.getSprintProgress(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Lifecycle Stages (Idea → Design → Development → QA → Done) ─────

    const STAGE_ORDER = ['idea', 'design', 'development', 'qa', 'done'];

    // Design-mode work runs in the designs repo; developer-mode uses the default app dir.
    const modeWorkingDir = (mode) => (mode === 'design' ? config.DESIGNS_DIR : null);

    function nextStage(current) {
        const idx = STAGE_ORDER.indexOf(current || 'idea');
        if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
        return STAGE_ORDER[idx + 1];
    }

    function buildStagePrompt(fromStage, toStage, issue) {
        const typeLabel = issue.type || 'task';
        const header = `[Issue ${issue.id} — ${typeLabel.toUpperCase()}]\nTitle: ${issue.title}\nDescription: ${issue.description || '(no description)'}\n`;

        if (toStage === 'design') {
            return `${header}
You are in the **DESIGN** stage. Your job: produce a Product Requirements Document (PRD).

Steps:
1. Use the \`/create-prd\` skill to generate a thorough HTML PRD for this ${typeLabel}.
2. Include: problem statement, user stories, functional requirements, non-functional requirements, proposed architecture, API contracts (if any), UI notes, edge cases, success metrics.
3. Upload to S3 via the skill and share the org-restricted URL.
4. Do NOT write any implementation code yet. Design only.
5. At the end, output the PRD URL clearly on its own line starting with "PRD_URL:".`;
        }

        if (toStage === 'development') {
            const designRef = issue.design_session_id
                ? `The PRD was produced in session ${issue.design_session_id}${issue.prd_url ? ` (${issue.prd_url})` : ''}. Read it before starting.`
                : issue.prd_url
                    ? `PRD: ${issue.prd_url}`
                    : 'No PRD was generated — use the issue description as spec.';
            return `${header}
You are in the **DEVELOPMENT** stage. Your job: implement the feature/fix according to the spec.

${designRef}

Steps:
1. Read the PRD (if any) and the existing codebase to understand scope.
2. Write the code. Follow existing patterns in the repo.
3. Keep scope tight — only what the PRD / issue requires. No gratuitous refactors.
4. Verify locally: lint/typecheck/unit tests if they exist.
5. Do NOT deploy, do NOT push to UAT/prod, do NOT restart services. Just write code.
6. At the end, summarize what files you changed and what's been built.`;
        }

        if (toStage === 'qa') {
            const devRef = issue.session_id
                ? `Implementation was done in session ${issue.session_id}.`
                : 'No dev session linked — test against current codebase state.';
            return `${header}
You are in the **QA** stage. Your job: verify the feature works end-to-end.

${devRef}

Steps:
1. Use the \`/api-test-feature\` skill for API endpoints (create test data, hit each endpoint, verify responses).
2. If there is UI, use the \`browser-agent\` MCP to click through the flow in a real browser — check both happy path and edge cases.
3. Regression: confirm nearby features still work (don't break what's there).
4. Report PASS/FAIL for each test with supporting output (request/response, screenshot paths, logs).
5. If anything fails, describe the exact reproduction steps and the expected vs actual behavior. Do not fix the bug here — QA reports only.`;
        }

        if (toStage === 'done') {
            return null; // No agent; just state change
        }

        return null;
    }

    app.post('/api/issues/:id/advance-stage', requireAuth, async (req, res) => {
        try {
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot advance stages' });
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });

            const from = issue.stage || 'idea';
            const to = req.body.toStage || nextStage(from);
            if (!to) return res.status(400).json({ error: 'Already at final stage' });
            if (!STAGE_ORDER.includes(to)) return res.status(400).json({ error: 'Invalid stage' });

            // Done stage — just flip state, no agent.
            if (to === 'done') {
                const updated = store.updateIssue(issue.id, { stage: 'done', status: 'completed', completed_at: new Date().toISOString() });
                wsBroadcast('issue_updated', { issue: updated });
                return res.json({ success: true, issue: updated });
            }

            // Build prompt (use override if supplied)
            const prompt = (req.body.customPrompt && req.body.customPrompt.trim())
                ? req.body.customPrompt
                : buildStagePrompt(from, to, issue);
            if (!prompt) return res.status(400).json({ error: 'No prompt for this transition' });

            const phone = req.user.phone || req.user.email || req.user.id;
            const model = req.body.model || 'claude-opus-4-8';

            // Design issues spawn their stage sessions in the designs repo.
            const spawnMode = issue.mode === 'design' ? 'design' : 'developer';

            // Spawn new session for this stage
            const result = await messageHandler({
                isWeb: true,
                phone: String(phone),
                text: `[start fresh] ${prompt}`,
                pushName: req.user.displayName || req.user.email || 'Stage Runner',
                ownerId: req.user.id,
                model,
                workingDir: modeWorkingDir(spawnMode),
            });

            if (!result?.sessionId) return res.status(500).json({ error: 'Failed to start stage session' });
            store.updateSession(result.sessionId, { mode: spawnMode });

            // Update issue — set stage + link the stage's session
            const updates = { stage: to };
            if (to === 'design') updates.design_session_id = result.sessionId;
            else if (to === 'development') { updates.session_id = result.sessionId; updates.status = 'in_progress'; }
            else if (to === 'qa') updates.qa_session_id = result.sessionId;

            const updated = store.updateIssue(issue.id, updates);
            wsBroadcast('issue_updated', { issue: updated });
            res.json({ success: true, issue: updated, sessionId: result.sessionId, stage: to });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Pipeline: sessions + issues grouped by sprint ──────────

    // Pipeline: sprint groups summary only (no items). Items are fetched lazily per group.
    app.get('/api/pipeline/groups', requireAuth, (req, res) => {
        try {
            const sprints = store.getAllSprints();
            const counts = store.getPipelineCounts();

            const groups = counts.map(c => {
                const sprint = c.sprintId ? sprints.find(s => s.id === c.sprintId) : null;
                return {
                    sprintId: c.sprintId,
                    sprintName: sprint?.name || (c.sprintId ? '(Deleted sprint)' : 'Unassigned'),
                    sprintStatus: sprint?.status || null,
                    issueCount: c.issues || 0,
                    sessionCount: c.sessions || 0,
                    total: (c.issues || 0) + (c.sessions || 0),
                };
            });

            // Ensure every sprint is represented even if it has no items yet.
            for (const sp of sprints) {
                if (!groups.find(g => g.sprintId === sp.id)) {
                    groups.push({
                        sprintId: sp.id,
                        sprintName: sp.name,
                        sprintStatus: sp.status || null,
                        issueCount: 0,
                        sessionCount: 0,
                        total: 0,
                    });
                }
            }

            const order = { active: 0, planning: 1, null: 2, completed: 3 };
            groups.sort((a, b) => {
                const oa = order[a.sprintStatus ?? 'null'] ?? 2;
                const ob = order[b.sprintStatus ?? 'null'] ?? 2;
                if (oa !== ob) return oa - ob;
                return (a.sprintName || '').localeCompare(b.sprintName || '');
            });

            res.json({ groups });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Pipeline: paginated items for one sprint bucket. Use "__nosprint__" for Unassigned.
    app.get('/api/pipeline/groups/:sprintId/items', requireAuth, (req, res) => {
        try {
            const raw = req.params.sprintId;
            const sprintId = (raw === '__nosprint__' || raw === 'null' || !raw) ? null : raw;
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
            const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
            const { items, total } = store.getPipelineGroupItems(sprintId, limit, offset);
            res.json({ items, total, limit, offset });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Session stage control — similar to issues, but for sessions
    app.put('/api/sessions/:id/stage', requireAuth, (req, res) => {
        try {
            const allowed = ['stage', 'prd_url', 'design_session_id', 'dev_session_id', 'qa_session_id', 'sprint_id'];
            const updates = {};
            for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
            if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no valid fields' });
            store.updateSession(req.params.id, updates);
            const s = store.getSession(req.params.id);
            wsBroadcast('session_stage_updated', { session: s });
            res.json({ success: true, session: s });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/sessions/:id/stage-prompt', requireAuth, (req, res) => {
        try {
            const s = store.getSession(req.params.id);
            if (!s) return res.status(404).json({ error: 'Session not found' });
            const from = s.stage || 'idea';
            const to = req.query.toStage || nextStage(from);
            if (!to) return res.json({ from, to: null, prompt: null });
            const pseudoIssue = {
                id: s.id,
                type: 'task',
                title: s.task || 'Session',
                description: s.task || '',
                session_id: s.dev_session_id || s.id,
                design_session_id: s.design_session_id,
                qa_session_id: s.qa_session_id,
                prd_url: s.prd_url,
            };
            res.json({ from, to, prompt: buildStagePrompt(from, to, pseudoIssue) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/sessions/:id/advance-stage', requireAuth, async (req, res) => {
        try {
            if (req.user.role === 'tester') return res.status(403).json({ error: 'Testers cannot advance stages' });
            const s = store.getSession(req.params.id);
            if (!s) return res.status(404).json({ error: 'Session not found' });

            const from = s.stage || 'idea';
            const to = req.body.toStage || nextStage(from);
            if (!to) return res.status(400).json({ error: 'Already at final stage' });
            if (!STAGE_ORDER.includes(to)) return res.status(400).json({ error: 'Invalid stage' });

            if (to === 'done') {
                store.updateSession(s.id, { stage: 'done' });
                const updated = store.getSession(s.id);
                wsBroadcast('session_stage_updated', { session: updated });
                return res.json({ success: true, session: updated });
            }

            const pseudoIssue = {
                id: s.id,
                type: 'task',
                title: s.task || 'Session',
                description: s.task || '',
                session_id: s.dev_session_id || s.id,
                design_session_id: s.design_session_id,
                qa_session_id: s.qa_session_id,
                prd_url: s.prd_url,
            };
            const prompt = (req.body.customPrompt && req.body.customPrompt.trim())
                ? req.body.customPrompt
                : buildStagePrompt(from, to, pseudoIssue);
            if (!prompt) return res.status(400).json({ error: 'No prompt for this transition' });

            const phone = req.user.phone || req.user.email || req.user.id;
            const model = req.body.model || 'claude-opus-4-8';
            // Inherit the parent session's mode (design sessions advance into design sessions).
            const spawnMode = s.mode === 'design' ? 'design' : 'developer';
            const result = await messageHandler({
                isWeb: true,
                phone: String(phone),
                text: `[start fresh] ${prompt}`,
                pushName: req.user.displayName || req.user.email || 'Stage Runner',
                ownerId: req.user.id,
                model,
                workingDir: modeWorkingDir(spawnMode),
            });
            if (!result?.sessionId) return res.status(500).json({ error: 'Failed to start stage session' });
            store.updateSession(result.sessionId, { mode: spawnMode });

            // Link child session back to parent sprint
            if (s.sprint_id) store.updateSession(result.sessionId, { sprint_id: s.sprint_id });

            const updates = { stage: to };
            if (to === 'design') updates.design_session_id = result.sessionId;
            else if (to === 'development') updates.dev_session_id = result.sessionId;
            else if (to === 'qa') updates.qa_session_id = result.sessionId;
            store.updateSession(s.id, updates);
            const updated = store.getSession(s.id);
            wsBroadcast('session_stage_updated', { session: updated });
            res.json({ success: true, session: updated, sessionId: result.sessionId, stage: to });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/issues/:id/stage-prompt', requireAuth, (req, res) => {
        try {
            const issue = store.getIssue(req.params.id);
            if (!issue) return res.status(404).json({ error: 'Issue not found' });
            const from = issue.stage || 'idea';
            const to = req.query.toStage || nextStage(from);
            if (!to) return res.json({ from, to: null, prompt: null });
            const prompt = buildStagePrompt(from, to, issue);
            res.json({ from, to, prompt });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Autonomous Run (picks issues one by one) ─────────────────

    // In-memory state for autonomous runner
    const autonomousState = { running: false, currentIssueId: null, sessionId: null };

    app.get('/api/autonomous/status', requireAuth, (req, res) => {
        const selfDecisions = store.getSetting('self_decisions') === 'true';
        res.json({ ...autonomousState, selfDecisions });
    });

    app.put('/api/autonomous/self-decisions', requireAuth, (req, res) => {
        try {
            const { enabled } = req.body;
            store.setSetting('self_decisions', enabled ? 'true' : 'false');
            res.json({ success: true, selfDecisions: !!enabled });
        } catch (err) { res.status(500).json({ error: err.message }); }
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
            const model = req.body.model || 'claude-opus-4-8';
            const selfDecisions = store.getSetting('self_decisions') === 'true';
            const selfDecisionsHint = selfDecisions
                ? '\n\nIMPORTANT: Take all decisions yourself. Do NOT ask the user for clarification, confirmation, or choices. Use your best judgment based on the requirements, codebase context, and best practices. Just get it done autonomously.'
                : '';
            const taskPrompt = `[Issue ${issue.id}] ${issue.title}\n\n${issue.description || 'No additional details.'}${selfDecisionsHint}`;
            const spawnMode = issue.mode === 'design' ? 'design' : 'developer';
            let result;
            if (issue.fork_session_id && executionEngine) {
                // Fork inherits the parent session's working dir; design issues should still be forked from a design session.
                result = await executionEngine.forkSession(issue.fork_session_id, taskPrompt, String(phone), req.user.id, model);
            } else {
                result = await messageHandler({ isWeb: true, phone: String(phone), text: `[start fresh] ${taskPrompt}`, pushName: req.user.displayName || 'Autonomous', ownerId: req.user.id, model, workingDir: modeWorkingDir(spawnMode) });
            }

            if (result?.sessionId) {
                autonomousState.sessionId = result.sessionId;
                store.updateSession(result.sessionId, { mode: spawnMode });
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
                ? executionEngine.forkSession(next.fork_session_id, taskPrompt, 'system_autonomous', null, 'claude-opus-4-8')
                : messageHandler({ isWeb: true, phone: 'system_autonomous', text: `[start fresh] ${taskPrompt}`, pushName: 'Autonomous Runner', ownerId: null, model: 'claude-opus-4-8' });
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
        // Sprint board: a feature's dev session auto-advances to "Dev Completed" ONLY on a real
        // UAT deploy (the [[UAT_DEPLOYED]] marker). Any other "done" stays manual.
        const checkFeatureDone = (sessionId, content) => {
            try {
                if (!content || !content.includes('[[UAT_DEPLOYED]]')) return;
                const updated = store.markFeatureDoneBySession(sessionId);
                if (updated) wsBroadcast('issue_updated', { issue: updated });
            } catch (_) { /* non-fatal */ }
        };

        executionEngine.on('assistant_message', ({ sessionId, content }) => {
            checkFeatureDone(sessionId, content);
            wsBroadcast('assistant_message', { sessionId, content });
        });

        executionEngine.on('result', ({ sessionId, content, costUsd }) => {
            checkFeatureDone(sessionId, content);
            wsBroadcast('result', { sessionId, content, costUsd });
        });

        executionEngine.on('session_end', ({ sessionId, code, status, costUsd }) => {
            wsBroadcast('session_end', { sessionId, code, status, costUsd });
        });

        executionEngine.on('session_error', ({ sessionId, error }) => {
            wsBroadcast('session_error', { sessionId, error });
        });

        executionEngine.on('auth_error', ({ sessionId, error }) => {
            wsBroadcast('auth_error', { sessionId, error });
        });
    }

    // Expose broadcast for external use (issues, autonomous, etc.)
    app._wsBroadcast = wsBroadcast;

    server.listen(port, () => console.log(`[Dashboard] 🌐 Web Dashboard running on port ${port} (WebSocket: /ws)`));
}
