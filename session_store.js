// ============================================================
// session_store.js — SQLite-backed session & user persistence
// ============================================================

import Database from 'better-sqlite3';
import config from './config.js';
import crypto from 'crypto';

class SessionStore {
    constructor() {
        this.db = new Database(config.DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_phone TEXT NOT NULL,
                owner_id TEXT,
                claude_session_id TEXT,
                task TEXT,
                status TEXT DEFAULT 'running',
                thread_open INTEGER DEFAULT 1,
                working_dir TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                cost_usd REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT REFERENCES sessions(id),
                role TEXT NOT NULL,
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS allowed_phones (
                phone TEXT PRIMARY KEY,
                label TEXT,
                user_id TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                phone TEXT UNIQUE,
                display_name TEXT,
                role TEXT DEFAULT 'developer',
                is_admin INTEGER DEFAULT 0,
                password_hash TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS session_collaborators (
                session_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (session_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS access_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                requester_id TEXT NOT NULL,
                requester_name TEXT,
                requester_email TEXT,
                status TEXT DEFAULT 'pending',
                note TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                resolved_at DATETIME,
                resolved_by TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_phone);
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_collaborators_session ON session_collaborators(session_id);
            CREATE INDEX IF NOT EXISTS idx_collaborators_user ON session_collaborators(user_id);
            CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
            CREATE TABLE IF NOT EXISTS issues (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'todo',
                priority TEXT DEFAULT 'medium',
                labels TEXT DEFAULT '[]',
                created_by TEXT,
                assigned_to TEXT,
                session_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                sort_order INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
            CREATE INDEX IF NOT EXISTS idx_issues_created_by ON issues(created_by);
            CREATE TABLE IF NOT EXISTS bookmarks (
                user_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, session_id)
            );
            CREATE TABLE IF NOT EXISTS sprints (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'active',
                start_date TEXT,
                end_date TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
            CREATE TABLE IF NOT EXISTS system_prompts (
                key TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        const safeMigrations = [
            "ALTER TABLE sessions ADD COLUMN thread_open INTEGER DEFAULT 1",
            "ALTER TABLE sessions ADD COLUMN subscribers TEXT DEFAULT '[]'",
            "ALTER TABLE sessions ADD COLUMN owner_id TEXT",
            "ALTER TABLE allowed_phones ADD COLUMN user_id TEXT",
            "ALTER TABLE users ADD COLUMN password_hash TEXT",
            "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'developer'",
            "ALTER TABLE users ADD COLUMN created_by TEXT",
            "ALTER TABLE sessions ADD COLUMN model TEXT DEFAULT 'opus'",
            "ALTER TABLE issues ADD COLUMN fork_session_id TEXT",
            "ALTER TABLE issues ADD COLUMN sprint_id TEXT",
            "ALTER TABLE issues ADD COLUMN type TEXT DEFAULT 'task'",
            "ALTER TABLE sessions ADD COLUMN input_tokens INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN output_tokens INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN sprint_id TEXT",
        ];
        for (const sql of safeMigrations) {
            try { this.db.exec(sql); } catch (_) { /* column already exists */ }
        }
        try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id)'); } catch (_) { }
        try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id)'); } catch (_) { }
    }

    createSession(id, userPhone, task, claudeSessionId, workingDir, ownerId = null, model = 'opus') {
        this.db.prepare(
            `INSERT OR REPLACE INTO sessions (id, user_phone, owner_id, task, claude_session_id, status, working_dir, thread_open, model)
             VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?)`
        ).run(id, String(userPhone), ownerId, task, claudeSessionId, workingDir, model);
    }

    getSession(id) {
        return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    }

    getActiveSessions(userPhone) {
        return this.db.prepare(
            `SELECT * FROM sessions
             WHERE user_phone = ?
             AND (status = 'running' OR (status = 'stopped' AND updated_at >= datetime('now', '-1 day')))
             ORDER BY updated_at DESC`
        ).all(String(userPhone));
    }

    getCurrentThread(userPhone) {
        const phoneParam = String(userPhone);
        return this.db.prepare(
            `SELECT * FROM sessions
             WHERE user_phone = ? AND thread_open = 1 AND claude_session_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1`
        ).get(phoneParam);
    }

    updateSession(id, updates) {
        const fields = [];
        const values = [];
        for (const [key, val] of Object.entries(updates)) {
            if (key === 'subscribers_arr') {
                fields.push(`subscribers = ?`);
                values.push(JSON.stringify(val));
            } else {
                fields.push(`${key} = ?`);
                values.push(val);
            }
        }
        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE sessions SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    }

    getAllActiveSessions() {
        return this.db.prepare(
            `SELECT s.*, u.display_name as owner_name, u.email as owner_email
             FROM sessions s LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.status = 'running' ORDER BY s.updated_at DESC`
        ).all();
    }

    getTotalCost() {
        return this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM sessions').get().total;
    }

    getTotalTokens() {
        return this.db.prepare('SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output FROM sessions').get();
    }

    getSessionsForUser(userId, limit = 20, offset = 0) {
        return this.db.prepare(
            `SELECT s.*,
                    u.display_name as owner_name,
                    u.email as owner_email,
                    CASE WHEN s.owner_id = ? THEN 1 ELSE 0 END as is_mine,
                    CASE WHEN sc.user_id IS NOT NULL THEN 1 ELSE 0 END as has_access
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             LEFT JOIN session_collaborators sc ON sc.session_id = s.id AND sc.user_id = ?
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(userId, userId, limit, offset);
    }

    getOwnSessions(userId, limit = 20, offset = 0) {
        return this.db.prepare(
            `SELECT s.*,
                    u.display_name as owner_name,
                    u.email as owner_email,
                    1 as is_mine,
                    1 as has_access
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.owner_id = ?
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(userId, limit, offset);
    }

    countOwnSessions(userId) {
        return this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE owner_id = ?').get(userId).count;
    }

    getAllSessions(limit = 20, offset = 0) {
        return this.db.prepare(
            `SELECT s.*, u.display_name as owner_name, u.email as owner_email
             FROM sessions s LEFT JOIN users u ON s.owner_id = u.id
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(limit, offset);
    }

    countAllSessions() {
        return this.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    }

    setSessionStatus(id, status) {
        this.db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
    }

    closeThreadsForPhone(userPhone) {
        const phoneParam = String(userPhone);
        const likeParam = `%"${phoneParam}"%`;
        this.db.prepare(
            `UPDATE sessions SET thread_open = 0, updated_at = CURRENT_TIMESTAMP
             WHERE (user_phone = ? OR subscribers LIKE ?) AND thread_open = 1`
        ).run(phoneParam, likeParam);
    }

    closeThread(userPhone) { this.closeThreadsForPhone(userPhone); }

    cleanOrphanedSessions() {
        return this.db.prepare(`UPDATE sessions SET status = 'stopped' WHERE status = 'running'`).run().changes;
    }

    incrementCost(id, delta) {
        this.db.prepare('UPDATE sessions SET cost_usd = cost_usd + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(delta, id);
    }

    addMessage(sessionId, role, content) {
        this.db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, content);
    }

    upsertLastAssistantMessage(sessionId, content) {
        const lastMsg = this.db.prepare('SELECT id, role FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1').get(sessionId);
        if (lastMsg && lastMsg.role === 'assistant') {
            this.db.prepare('UPDATE messages SET content = ?, timestamp = CURRENT_TIMESTAMP WHERE id = ?').run(content, lastMsg.id);
        } else {
            this.addMessage(sessionId, 'assistant', content);
        }
    }

    getMessages(sessionId, limit = 20) {
        return this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?').all(sessionId, limit).reverse();
    }

    getAllowedPhones() {
        return this.db.prepare(
            `SELECT ap.*, u.email as user_email, u.display_name as user_name
             FROM allowed_phones ap LEFT JOIN users u ON ap.user_id = u.id
             ORDER BY ap.added_at DESC`
        ).all();
    }

    isPhoneAllowed(phone) {
        return !!this.db.prepare('SELECT phone FROM allowed_phones WHERE phone = ?').get(String(phone));
    }

    addAllowedPhone(phone, label = '', userId = null) {
        this.db.prepare('INSERT OR REPLACE INTO allowed_phones (phone, label, user_id) VALUES (?, ?, ?)').run(String(phone), label, userId);
    }

    removeAllowedPhone(phone) {
        this.db.prepare('DELETE FROM allowed_phones WHERE phone = ?').run(String(phone));
    }

    seedAllowedPhones(phones) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO allowed_phones (phone, label) VALUES (?, ?)');
        for (const phone of phones) insert.run(String(phone).trim(), 'seed');
    }

    createUser({ email, phone, displayName, role = 'developer', isAdmin = 0, passwordHash = null, createdBy = null }) {
        const id = crypto.randomUUID();
        this.db.prepare(
            `INSERT INTO users (id, email, phone, display_name, role, is_admin, password_hash, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, email || null, phone || null,
            displayName || email?.split('@')[0] || phone || 'User',
            role, isAdmin ? 1 : 0, passwordHash, createdBy);
        return this.getUserById(id);
    }

    getUserById(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
    getUserByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase().trim()); }
    getUserByPhone(phone) { return this.db.prepare('SELECT * FROM users WHERE phone = ?').get(String(phone)); }
    updateUserPassword(userId, passwordHash) { this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId); }
    deleteUser(userId) { this.db.prepare('DELETE FROM users WHERE id = ?').run(userId); }

    linkPhoneToUser(userId, phone) {
        this.db.prepare('UPDATE users SET phone = NULL WHERE phone = ? AND id != ?').run(String(phone), userId);
        this.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(String(phone), userId);
        this.db.prepare('UPDATE allowed_phones SET user_id = ? WHERE phone = ?').run(userId, String(phone));
    }

    getAllUsers() {
        return this.db.prepare(
            `SELECT u.id, u.email, u.phone, u.display_name, u.role, u.is_admin, u.created_at,
                    creator.display_name as created_by_name
             FROM users u
             LEFT JOIN users creator ON u.created_by = creator.id
             ORDER BY u.created_at DESC`
        ).all();
    }

    getAdmins() { return this.db.prepare('SELECT * FROM users WHERE is_admin = 1').all(); }

    static hashPassword(plain) {
        const salt = 'wa-engineer-salt-2025';
        return crypto.createHash('sha256').update(salt + plain).digest('hex');
    }

    verifyPassword(email, plain) {
        const user = this.getUserByEmail(email);
        if (!user || !user.password_hash) return null;
        const hash = SessionStore.hashPassword(plain);
        if (user.password_hash !== hash) return null;
        return user;
    }

    addCollaborator(sessionId, userId) {
        this.db.prepare('INSERT OR IGNORE INTO session_collaborators (session_id, user_id) VALUES (?, ?)').run(sessionId, userId);
    }

    removeCollaborator(sessionId, userId) {
        this.db.prepare('DELETE FROM session_collaborators WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
    }

    isCollaborator(sessionId, userId) {
        return !!this.db.prepare('SELECT 1 FROM session_collaborators WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
    }

    getCollaborators(sessionId) {
        return this.db.prepare(
            `SELECT u.id, u.email, u.phone, u.display_name, sc.granted_at
             FROM session_collaborators sc JOIN users u ON sc.user_id = u.id
             WHERE sc.session_id = ?`
        ).all(sessionId);
    }

    createAccessRequest(sessionId, requesterId, requesterName, requesterEmail, note = '') {
        const id = crypto.randomUUID();
        this.db.prepare(
            `INSERT INTO access_requests (id, session_id, requester_id, requester_name, requester_email, note)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, sessionId, requesterId, requesterName, requesterEmail, note);
        return id;
    }

    getPendingAccessRequests() {
        return this.db.prepare(
            `SELECT ar.*, s.task as session_task, s.updated_at as session_updated
             FROM access_requests ar
             JOIN sessions s ON ar.session_id = s.id
             WHERE ar.status = 'pending'
             ORDER BY ar.created_at DESC`
        ).all();
    }

    countPendingRequests() {
        return this.db.prepare("SELECT COUNT(*) as count FROM access_requests WHERE status = 'pending'").get().count;
    }

    resolveAccessRequest(requestId, resolvedBy, approve = true) {
        const status = approve ? 'approved' : 'rejected';
        this.db.prepare(`UPDATE access_requests SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`).run(status, resolvedBy, requestId);
        if (approve) {
            const req = this.db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId);
            if (req) this.addCollaborator(req.session_id, req.requester_id);
        }
    }

    // ── Issues ─────────────────────────────────────────────────

    createIssue({ title, description = '', priority = 'medium', labels = [], createdBy = null, forkSessionId = null, sprintId = null, assignedTo = null, type = 'task' }) {
        const id = `ISS-${Date.now().toString(36)}`;
        const maxOrder = this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM issues WHERE status = 'todo'").get().m;
        this.db.prepare(
            `INSERT INTO issues (id, title, description, priority, labels, created_by, sort_order, fork_session_id, sprint_id, assigned_to, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, title, description, priority, JSON.stringify(labels), createdBy, maxOrder + 1, forkSessionId, sprintId, assignedTo, type);
        return this.getIssue(id);
    }

    getIssue(id) { return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id); }

    getAllIssues() {
        return this.db.prepare(
            `SELECT i.*, u.display_name as creator_name, a.display_name as assignee_name
             FROM issues i
             LEFT JOIN users u ON i.created_by = u.id
             LEFT JOIN users a ON i.assigned_to = a.id
             ORDER BY i.sort_order ASC, i.created_at DESC`
        ).all();
    }

    getIssuesByStatus(status) {
        return this.db.prepare('SELECT i.*, u.display_name as creator_name FROM issues i LEFT JOIN users u ON i.created_by = u.id WHERE i.status = ? ORDER BY i.sort_order ASC').all(status);
    }

    updateIssue(id, updates) {
        const fields = [];
        const values = [];
        for (const [key, val] of Object.entries(updates)) {
            if (key === 'labels') {
                fields.push('labels = ?');
                values.push(JSON.stringify(val));
            } else {
                fields.push(`${key} = ?`);
                values.push(val);
            }
        }
        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE issues SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
        return this.getIssue(id);
    }

    deleteIssue(id) { this.db.prepare('DELETE FROM issues WHERE id = ?').run(id); }

    getNextTodoIssue() {
        return this.db.prepare("SELECT * FROM issues WHERE status = 'todo' ORDER BY sort_order ASC LIMIT 1").get();
    }

    countIssuesByStatus() {
        return this.db.prepare("SELECT status, COUNT(*) as count FROM issues GROUP BY status").all();
    }

    // ── Bookmarks ────────────────────────────────────────────────

    toggleBookmark(userId, sessionId) {
        const existing = this.db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND session_id = ?').get(userId, sessionId);
        if (existing) {
            this.db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
            return false;
        } else {
            this.db.prepare('INSERT INTO bookmarks (user_id, session_id) VALUES (?, ?)').run(userId, sessionId);
            return true;
        }
    }

    getBookmarkedSessionIds(userId) {
        return new Set(this.db.prepare('SELECT session_id FROM bookmarks WHERE user_id = ?').all(userId).map(r => r.session_id));
    }

    // ── Sprints ──────────────────────────────────────────────────

    createSprint({ name, description = '', startDate = null, endDate = null, createdBy = null }) {
        const id = `SPR-${Date.now().toString(36)}`;
        this.db.prepare(
            `INSERT INTO sprints (id, name, description, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, name, description, startDate, endDate, createdBy);
        return this.getSprint(id);
    }

    getSprint(id) { return this.db.prepare('SELECT * FROM sprints WHERE id = ?').get(id); }

    getAllSprints() {
        return this.db.prepare(
            `SELECT s.*, u.display_name as creator_name,
                    (SELECT COUNT(*) FROM issues WHERE sprint_id = s.id) as issue_count,
                    (SELECT COUNT(*) FROM issues WHERE sprint_id = s.id AND status = 'completed') as completed_count
             FROM sprints s LEFT JOIN users u ON s.created_by = u.id
             ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, s.created_at DESC`
        ).all();
    }

    updateSprint(id, updates) {
        const fields = [];
        const values = [];
        for (const [key, val] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(val);
        }
        if (fields.length === 0) return;
        values.push(id);
        this.db.prepare(`UPDATE sprints SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
        return this.getSprint(id);
    }

    deleteSprint(id) {
        // Unlink issues from this sprint
        this.db.prepare('UPDATE issues SET sprint_id = NULL WHERE sprint_id = ?').run(id);
        this.db.prepare('DELETE FROM sprints WHERE id = ?').run(id);
    }

    getSessionsBySprint(sprintId) {
        return this.db.prepare(
            `SELECT s.id, s.task, s.status, s.model, s.created_at, s.updated_at, s.cost_usd, s.input_tokens, s.output_tokens,
                    u.display_name as owner_name
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.sprint_id = ?
             ORDER BY s.created_at DESC`
        ).all(sprintId);
    }

    getSessionSummaryMessages(sessionId, limit = 50) {
        return this.db.prepare(
            `SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`
        ).all(sessionId, limit).reverse();
    }

    getIssuesBySprint(sprintId) {
        return this.db.prepare(
            `SELECT i.*, u.display_name as creator_name, a.display_name as assignee_name
             FROM issues i
             LEFT JOIN users u ON i.created_by = u.id
             LEFT JOIN users a ON i.assigned_to = a.id
             WHERE i.sprint_id = ?
             ORDER BY i.sort_order ASC, i.created_at DESC`
        ).all(sprintId);
    }

    getSystemPrompt(key) { return this.db.prepare('SELECT * FROM system_prompts WHERE key = ?').get(key); }

    setSystemPrompt(key, prompt, updatedBy = null) {
        this.db.prepare(
            `INSERT INTO system_prompts (key, prompt, updated_at, updated_by)
             VALUES (?, ?, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(key) DO UPDATE SET prompt = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?`
        ).run(key, prompt, updatedBy, prompt, updatedBy);
    }

    getAllSystemPrompts() { return this.db.prepare('SELECT * FROM system_prompts ORDER BY key').all(); }

    getSetting(key) {
        const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    setSetting(key, value) {
        this.db.prepare(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
        ).run(key, value, value);
    }

    getAllSettings() {
        const rows = this.db.prepare('SELECT key, value FROM app_settings').all();
        const settings = {};
        for (const r of rows) settings[r.key] = r.value;
        return settings;
    }

    getSessionStore() { return this.db; }
}

export default SessionStore;
