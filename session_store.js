// ============================================================
// session_store.js — SQLite-backed session & user persistence
// ============================================================

import Database from 'better-sqlite3';
import config from './config.js';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
            CREATE TABLE IF NOT EXISTS session_share_links (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                token TEXT UNIQUE NOT NULL,
                permission TEXT DEFAULT 'write',
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                revoked_at DATETIME,
                used_count INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_share_links_session ON session_share_links(session_id);
            CREATE INDEX IF NOT EXISTS idx_share_links_token ON session_share_links(token);
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
            CREATE TABLE IF NOT EXISTS prds (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                s3_key TEXT,
                url TEXT,
                sprint_id TEXT,
                issue_id TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_prds_sprint ON prds(sprint_id);
            CREATE TABLE IF NOT EXISTS bugs (
                id TEXT PRIMARY KEY,
                issue_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                severity TEXT DEFAULT 'normal',
                status TEXT DEFAULT 'open',
                created_by TEXT,
                fix_session_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_bugs_issue ON bugs(issue_id);
            CREATE TABLE IF NOT EXISTS test_cases (
                id TEXT PRIMARY KEY,
                issue_id TEXT NOT NULL,
                title TEXT NOT NULL,
                steps TEXT DEFAULT '',
                expected TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                source TEXT DEFAULT 'manual',
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_test_cases_issue ON test_cases(issue_id);
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
            "ALTER TABLE issues ADD COLUMN category TEXT DEFAULT 'issue'",
            "ALTER TABLE issues ADD COLUMN stage TEXT DEFAULT 'idea'",
            "ALTER TABLE issues ADD COLUMN design_session_id TEXT",
            "ALTER TABLE issues ADD COLUMN qa_session_id TEXT",
            "ALTER TABLE issues ADD COLUMN prd_url TEXT",
            "ALTER TABLE sessions ADD COLUMN stage TEXT DEFAULT 'idea'",
            "ALTER TABLE sessions ADD COLUMN design_session_id TEXT",
            "ALTER TABLE sessions ADD COLUMN qa_session_id TEXT",
            "ALTER TABLE sessions ADD COLUMN prd_url TEXT",
            "ALTER TABLE sessions ADD COLUMN dev_session_id TEXT",
            "ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'task'",
            "ALTER TABLE sessions ADD COLUMN labels TEXT DEFAULT '[]'",
            "ALTER TABLE sessions ADD COLUMN name TEXT",
            "ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'developer'",
            "ALTER TABLE issues ADD COLUMN mode TEXT DEFAULT 'developer'",
            // Tester role: per-user code-edit permission, and the per-session edit gate
            // copied from the tester's setting when a session is forked for testing.
            "ALTER TABLE users ADD COLUMN can_edit INTEGER DEFAULT 1",
            "ALTER TABLE sessions ADD COLUMN edit_access INTEGER DEFAULT 1",
            // Tester access scope: 0 = chat access (can chat with the bot, current tester),
            // 1 = sprint-only (can only view & edit the sprint board, no chat / no sessions).
            "ALTER TABLE users ADD COLUMN sprint_only INTEGER DEFAULT 0",
            // Sprint board (spreadsheet-style feature tracking) — each issue is a feature/story row.
            "ALTER TABLE issues ADD COLUMN platform TEXT DEFAULT ''",
            "ALTER TABLE issues ADD COLUMN qa_owner TEXT DEFAULT ''",
            "ALTER TABLE issues ADD COLUMN dev_status TEXT DEFAULT 'todo'",
            "ALTER TABLE issues ADD COLUMN dev_percent INTEGER DEFAULT 0",
            "ALTER TABLE issues ADD COLUMN dev_handover_date TEXT",
            "ALTER TABLE issues ADD COLUMN qa_handover_date TEXT",
            "ALTER TABLE issues ADD COLUMN test_cases_count INTEGER DEFAULT 0",
            "ALTER TABLE issues ADD COLUMN test_cases_done_date TEXT",
            "ALTER TABLE issues ADD COLUMN qa_status TEXT DEFAULT ''",
            "ALTER TABLE issues ADD COLUMN open_bugs INTEGER DEFAULT 0",
            "ALTER TABLE issues ADD COLUMN critical_bugs INTEGER DEFAULT 0",
            "ALTER TABLE issues ADD COLUMN qa_comments TEXT DEFAULT ''",
            // Backlog: features parked out of the active sprint board.
            "ALTER TABLE issues ADD COLUMN is_backlog INTEGER DEFAULT 0",
            // Subtasks: a child issue points at its parent feature.
            "ALTER TABLE issues ADD COLUMN parent_issue_id TEXT",
            // Single deadline per feature (replaces dev/QA handover dates), set on create.
            "ALTER TABLE issues ADD COLUMN deadline TEXT",
            // Source of a session: 'agent' (claude --print, Agent-SDK billed) vs
            // 'terminal' (interactive web terminal /sessions/v2, subscription billed).
            "ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'agent'",
            "ALTER TABLE sessions ADD COLUMN bookmarked INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT",
        ];
        for (const sql of safeMigrations) {
            try { this.db.exec(sql); } catch (_) { /* column already exists */ }
        }
        try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id)'); } catch (_) { }
        try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id)'); } catch (_) { }
    }

    createSession(id, userPhone, task, claudeSessionId, workingDir, ownerId = null, model = 'claude-opus-4-8') {
        this.db.prepare(
            `INSERT OR REPLACE INTO sessions (id, user_phone, owner_id, task, claude_session_id, status, working_dir, thread_open, model)
             VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?)`
        ).run(id, String(userPhone), ownerId, task, claudeSessionId, workingDir, model);
    }

    getSession(id) {
        return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    }

    // ── Interactive web-terminal (/sessions/v2) bridge ──────────────────
    // A terminal session's id IS the Claude session UUID (set via --session-id),
    // so resume/fork map directly onto `claude --resume <id>`. Subscription-billed.
    createTerminalSession(id, ownerId, name, workingDir, model = 'claude-opus-4-8', parentSessionId = null) {
        this.db.prepare(
            `INSERT OR IGNORE INTO sessions
               (id, user_phone, owner_id, task, name, claude_session_id, status, working_dir, thread_open, model, source, parent_session_id)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 1, ?, 'terminal', ?)`
        ).run(id, String(ownerId || 'web'), ownerId, name || 'Terminal session', name || null, id, workingDir, model, parentSessionId);
        return this.getSession(id);
    }

    // Path to Claude Code's own JSONL transcript for a session (its native store).
    transcriptPath(sessionId, workingDir) {
        const folder = (workingDir || config.DEFAULT_WORKING_DIR).replace(/\//g, '-');
        return path.join(os.homedir(), '.claude', 'projects', folder, `${sessionId}.jsonl`);
    }

    getSessionByClaudeId(claudeId) {
        return this.db.prepare('SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY updated_at DESC LIMIT 1').get(claudeId);
    }

    // Parse the JSONL transcript into the messages table (for history / search /
    // share). The transcript file is keyed by the Claude UUID (claudeId), while the
    // messages rows are keyed by the OliBot row id (rowId) — these differ for agent
    // sessions. Idempotent — replaces prior rows. Returns the parsed messages.
    syncTranscript(rowId, workingDir, claudeId = null) {
        const file = this.transcriptPath(claudeId || rowId, workingDir);
        if (!fs.existsSync(file)) return { messages: [], synced: 0 };

        const blockText = (content) => {
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                return content.map(b => {
                    if (b.type === 'text') return b.text;
                    if (b.type === 'tool_use') return `⚙ ${b.name}`;
                    return '';
                }).filter(Boolean).join('\n');
            }
            return '';
        };

        const msgs = [];
        let inTok = 0, outTok = 0;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            if (o.type !== 'user' && o.type !== 'assistant') continue;
            if (o.message?.usage) {
                inTok += o.message.usage.input_tokens || 0;
                outTok += o.message.usage.output_tokens || 0;
            }
            const text = blockText(o.message?.content);
            if (text && text.trim()) msgs.push({ role: o.message?.role || o.type, content: text, ts: o.timestamp || null });
        }

        // ONLY persist for terminal sessions — their JSONL is the source of truth.
        // Agent / --print sessions are already populated live by claude_manager with
        // richer formatting; NEVER delete+overwrite those (it clobbers v1 chat
        // history). For non-terminal sessions we just return the parsed messages so
        // the history view can display them without touching the stored rows.
        const row = this.getSession(rowId);
        if (row && row.source === 'terminal') {
            const tx = this.db.transaction(() => {
                this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(rowId);
                const ins = this.db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
                for (const m of msgs) ins.run(rowId, m.role, m.content, m.ts);
            });
            tx();
            try { this.updateSession(rowId, { input_tokens: inTok, output_tokens: outTok }); } catch (_) {}
        }
        return { messages: msgs, synced: msgs.length };
    }

    // After a --fork-session resume, Claude writes a NEW uuid.jsonl. Find it so we
    // can register the fork. Returns the newest transcript id created since `sinceMs`
    // (excluding the parent), or null.
    detectNewSession(workingDir, sinceMs, excludeId) {
        try {
            const folder = (workingDir || config.DEFAULT_WORKING_DIR).replace(/\//g, '-');
            const dir = path.join(os.homedir(), '.claude', 'projects', folder);
            if (!fs.existsSync(dir)) return null;
            let best = null, bestM = 0;
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.jsonl')) continue;
                const id = f.replace(/\.jsonl$/, '');
                if (id === excludeId) continue;
                const m = fs.statSync(path.join(dir, f)).mtimeMs;
                if (m >= sinceMs && m > bestM) { best = id; bestM = m; }
            }
            return best;
        } catch (_) { return null; }
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
            } else if (key === 'labels' && Array.isArray(val)) {
                fields.push(`labels = ?`);
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

    // Cost meter: aggregate per-session API-equivalent cost (cost_usd) across
    // time windows + by model, plus the most expensive recent sessions. Purely
    // informational — no caps/limits. Note: programmatic (--print) sessions are
    // billed from the separate Agent SDK credit pool as of 2026-06-15.
    getCostStats(recentLimit = 50) {
        const win = (sql) => this.db.prepare(
            `SELECT COALESCE(SUM(cost_usd),0) cost, COUNT(*) count FROM sessions WHERE cost_usd IS NOT NULL${sql}`
        ).get();

        const today = win(" AND created_at >= date('now','start of day')");
        const last7 = win(" AND created_at >= datetime('now','-7 day')");
        const last30 = win(" AND created_at >= datetime('now','-30 day')");
        const month = win(" AND created_at >= date('now','start of month')");
        const all = win('');

        const byModel = this.db.prepare(
            `SELECT COALESCE(NULLIF(model,''),'unknown') model,
                    COALESCE(SUM(cost_usd),0) cost, COUNT(*) count
             FROM sessions WHERE cost_usd IS NOT NULL
             GROUP BY COALESCE(NULLIF(model,''),'unknown')
             ORDER BY cost DESC`
        ).all();

        // Last 14 days of daily spend for a sparkline
        const daily = this.db.prepare(
            `SELECT date(created_at) day, COALESCE(SUM(cost_usd),0) cost, COUNT(*) count
             FROM sessions
             WHERE cost_usd IS NOT NULL AND created_at >= datetime('now','-14 day')
             GROUP BY date(created_at) ORDER BY day ASC`
        ).all();

        const topSessions = this.db.prepare(
            `SELECT s.id, s.task, s.model, s.cost_usd cost, s.status, s.created_at,
                    u.display_name owner
             FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
             WHERE s.cost_usd IS NOT NULL AND s.cost_usd > 0
             ORDER BY s.cost_usd DESC LIMIT ?`
        ).all(recentLimit);

        const avgPerSession = all.count > 0 ? all.cost / all.count : 0;

        return { today, last7, last30, month, all, avgPerSession, byModel, daily, topSessions };
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

    _searchPattern(q) {
        return `%${String(q).trim().replace(/[%_]/g, (m) => '\\' + m)}%`;
    }

    searchSessionsForUser(userId, q, limit = 20, offset = 0) {
        const pattern = this._searchPattern(q);
        return this.db.prepare(
            `SELECT s.*,
                    u.display_name as owner_name,
                    u.email as owner_email,
                    CASE WHEN s.owner_id = ? THEN 1 ELSE 0 END as is_mine,
                    1 as has_access
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.name LIKE ? ESCAPE '\\'
                OR s.task LIKE ? ESCAPE '\\'
                OR s.id LIKE ? ESCAPE '\\'
                OR u.display_name LIKE ? ESCAPE '\\'
                OR u.email LIKE ? ESCAPE '\\'
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(userId, pattern, pattern, pattern, pattern, pattern, limit, offset);
    }

    searchOwnSessions(userId, q, limit = 20, offset = 0) {
        const pattern = this._searchPattern(q);
        return this.db.prepare(
            `SELECT s.*,
                    u.display_name as owner_name,
                    u.email as owner_email,
                    1 as is_mine,
                    1 as has_access
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.owner_id = ?
               AND (s.name LIKE ? ESCAPE '\\'
                    OR s.task LIKE ? ESCAPE '\\'
                    OR s.id LIKE ? ESCAPE '\\')
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(userId, pattern, pattern, pattern, limit, offset);
    }

    countSearchSessionsForUser(q) {
        const pattern = this._searchPattern(q);
        return this.db.prepare(
            `SELECT COUNT(*) as count
             FROM sessions s LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.name LIKE ? ESCAPE '\\'
                OR s.task LIKE ? ESCAPE '\\'
                OR s.id LIKE ? ESCAPE '\\'
                OR u.display_name LIKE ? ESCAPE '\\'
                OR u.email LIKE ? ESCAPE '\\'`
        ).get(pattern, pattern, pattern, pattern, pattern).count;
    }

    countSearchOwnSessions(userId, q) {
        const pattern = this._searchPattern(q);
        return this.db.prepare(
            `SELECT COUNT(*) as count FROM sessions s
             WHERE s.owner_id = ?
               AND (s.name LIKE ? ESCAPE '\\'
                    OR s.task LIKE ? ESCAPE '\\'
                    OR s.id LIKE ? ESCAPE '\\')`
        ).get(userId, pattern, pattern, pattern).count;
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

    createUser({ email, phone, displayName, role = 'developer', isAdmin = 0, canEdit = 1, sprintOnly = 0, passwordHash = null, createdBy = null }) {
        const id = crypto.randomUUID();
        this.db.prepare(
            `INSERT INTO users (id, email, phone, display_name, role, is_admin, can_edit, sprint_only, password_hash, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, email || null, phone || null,
            displayName || email?.split('@')[0] || phone || 'User',
            role, isAdmin ? 1 : 0, canEdit ? 1 : 0, sprintOnly ? 1 : 0, passwordHash, createdBy);
        return this.getUserById(id);
    }

    // Update a user's role / admin / edit-access / sprint-only (used by the Users settings panel).
    updateUser(userId, { role, isAdmin, canEdit, sprintOnly } = {}) {
        const fields = [];
        const values = [];
        if (role !== undefined) { fields.push('role = ?'); values.push(role); }
        if (isAdmin !== undefined) { fields.push('is_admin = ?'); values.push(isAdmin ? 1 : 0); }
        if (canEdit !== undefined) { fields.push('can_edit = ?'); values.push(canEdit ? 1 : 0); }
        if (sprintOnly !== undefined) { fields.push('sprint_only = ?'); values.push(sprintOnly ? 1 : 0); }
        if (!fields.length) return this.getUserById(userId);
        values.push(userId);
        this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return this.getUserById(userId);
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
            `SELECT u.id, u.email, u.phone, u.display_name, u.role, u.is_admin, u.can_edit, u.sprint_only, u.created_at,
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

    createIssue({ title, description = '', priority = 'medium', labels = [], createdBy = null, forkSessionId = null, sprintId = null, assignedTo = null, type = 'task', category = 'issue', mode = 'developer', platform = '', qaOwner = '', parentIssueId = null, sessionId = null, deadline = null }) {
        const id = `ISS-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
        const maxOrder = this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) as m FROM issues WHERE status = 'todo'").get().m;
        this.db.prepare(
            `INSERT INTO issues (id, title, description, priority, labels, created_by, sort_order, fork_session_id, sprint_id, assigned_to, type, category, mode, platform, qa_owner, parent_issue_id, session_id, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, title, description, priority, JSON.stringify(labels), createdBy, maxOrder + 1, forkSessionId, sprintId, assignedTo, type, category, mode === 'design' ? 'design' : 'developer', platform, qaOwner, parentIssueId, sessionId, deadline);
        return this.getIssue(id);
    }

    getIssue(id) { return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id); }

    // Subtasks = child issues of a feature. Enriched with completion like the board rows.
    getSubtasks(parentIssueId) {
        return this.db.prepare(
            `SELECT i.*, a.display_name as assignee_name FROM issues i
             LEFT JOIN users a ON i.assigned_to = a.id
             WHERE i.parent_issue_id = ? ORDER BY i.created_at ASC`
        ).all(parentIssueId).map(r => ({ ...r, completion: this.featureCompletion(r) }));
    }

    getAllIssues() {
        return this.db.prepare(
            `SELECT i.*, u.display_name as creator_name, a.display_name as assignee_name
             FROM issues i
             LEFT JOIN users u ON i.created_by = u.id
             LEFT JOIN users a ON i.assigned_to = a.id
             ORDER BY i.sort_order ASC, i.created_at DESC`
        ).all().map(r => ({ ...r, completion: this.featureCompletion(r) }));
    }

    // Single source of truth for a feature's completion %, driven by the QA lifecycle:
    //   QA Pass / Done → 100 · Dev Completed (no open bugs) → 70 · Dev Completed + open QA bug → 50
    //   To Do / In Progress → 0
    // The frontend mirrors this exact logic in SprintBoard.jsx (featureCompletion) for
    // instant display; keep the two in sync.
    featureCompletion(issue) {
        if (!issue) return 0;
        const qa = String(issue.qa_status || '').toLowerCase();
        if (qa === 'pass' || qa === 'passed' || qa === 'tested') return 100;
        if (issue.dev_status === 'done') return 100;
        if (issue.dev_status === 'dev_completed') return (issue.open_bugs || 0) > 0 ? 50 : 70;
        return 0; // todo / in_progress
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

    deleteSession(id) {
        const tx = this.db.transaction((sessionId) => {
            this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
            this.db.prepare('DELETE FROM session_collaborators WHERE session_id = ?').run(sessionId);
            this.db.prepare('DELETE FROM session_share_links WHERE session_id = ?').run(sessionId);
            this.db.prepare('DELETE FROM access_requests WHERE session_id = ?').run(sessionId);
            this.db.prepare('DELETE FROM bookmarks WHERE session_id = ?').run(sessionId);
            this.db.prepare('UPDATE issues SET session_id = NULL WHERE session_id = ?').run(sessionId);
            this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        });
        tx(id);
    }

    getNextTodoIssue() {
        return this.db.prepare("SELECT * FROM issues WHERE status = 'todo' ORDER BY sort_order ASC LIMIT 1").get();
    }

    countIssuesByStatus() {
        return this.db.prepare("SELECT status, COUNT(*) as count FROM issues GROUP BY status").all();
    }

    // Feature (issue) linked to a dev session — used by the UAT-deploy auto-detect hook.
    getFeatureBySession(sessionId) {
        return this.db.prepare('SELECT * FROM issues WHERE session_id = ? LIMIT 1').get(sessionId);
    }

    // Auto-flip a feature to Done when its linked dev session reports a successful UAT deploy.
    // Returns the updated issue if a change was made, else null.
    // The dev session signalling completion (UAT push / agent decides done) moves the feature to
    // "Dev Completed" so QA can pick it up. Final "QA Pass" (100%) is set by QA on the board.
    markFeatureDoneBySession(sessionId) {
        const issue = this.getFeatureBySession(sessionId);
        if (!issue) return null;
        if (issue.dev_status === 'dev_completed' || issue.dev_status === 'done') return null;
        this.db.prepare(
            `UPDATE issues SET dev_status = 'dev_completed', status = 'in_progress',
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(issue.id);
        return this.getIssue(issue.id);
    }

    // Set a feature's lifecycle status from its linked session (the Workspace status control).
    // status: 'in_progress' | 'dev_completed' | 'qa_pass'
    setFeatureStatusBySession(sessionId, status) {
        const issue = this.getFeatureBySession(sessionId);
        if (!issue) return null;
        if (status === 'qa_pass') {
            this.db.prepare(`UPDATE issues SET qa_status = 'pass', dev_status = CASE WHEN dev_status IN ('todo','in_progress') THEN 'dev_completed' ELSE dev_status END, status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(issue.id);
        } else if (status === 'dev_completed') {
            this.db.prepare(`UPDATE issues SET dev_status = 'dev_completed', status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(issue.id);
        } else { // in_progress
            this.db.prepare(`UPDATE issues SET dev_status = 'in_progress', qa_status = CASE WHEN qa_status = 'pass' THEN '' ELSE qa_status END, status = 'in_progress', completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(issue.id);
        }
        return this.getIssue(issue.id);
    }

    // ── Bugs (per feature) ───────────────────────────────────────
    createBug({ issueId, title, description = '', severity = 'normal', createdBy = null }) {
        const id = `BUG-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
        this.db.prepare(
            `INSERT INTO bugs (id, issue_id, title, description, severity, created_by) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, issueId, title, description, severity, createdBy);
        this.recountBugs(issueId);
        return this.getBug(id);
    }

    getBug(id) { return this.db.prepare('SELECT * FROM bugs WHERE id = ?').get(id); }

    getBugsByIssue(issueId) {
        return this.db.prepare(
            `SELECT b.*, u.display_name as creator_name FROM bugs b
             LEFT JOIN users u ON b.created_by = u.id
             WHERE b.issue_id = ? ORDER BY b.created_at DESC`
        ).all(issueId);
    }

    updateBug(id, updates) {
        const allowed = ['title', 'description', 'severity', 'status', 'fix_session_id'];
        const sets = [], vals = [];
        for (const [k, v] of Object.entries(updates)) {
            if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (sets.length === 0) return this.getBug(id);
        sets.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(id);
        this.db.prepare(`UPDATE bugs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        const bug = this.getBug(id);
        if (bug) this.recountBugs(bug.issue_id);
        return bug;
    }

    deleteBug(id) {
        const bug = this.getBug(id);
        this.db.prepare('DELETE FROM bugs WHERE id = ?').run(id);
        if (bug) this.recountBugs(bug.issue_id);
    }

    // Keep issue.open_bugs / critical_bugs in sync with the bugs table.
    recountBugs(issueId) {
        const open = this.db.prepare("SELECT COUNT(*) as n FROM bugs WHERE issue_id = ? AND status NOT IN ('fixed','wont_fix')").get(issueId).n;
        const critical = this.db.prepare("SELECT COUNT(*) as n FROM bugs WHERE issue_id = ? AND severity = 'critical' AND status NOT IN ('fixed','wont_fix')").get(issueId).n;
        this.db.prepare('UPDATE issues SET open_bugs = ?, critical_bugs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(open, critical, issueId);
    }

    // ── Test cases (per feature) ─────────────────────────────────
    createTestCase({ issueId, title, steps = '', expected = '', status = 'pending', source = 'manual', createdBy = null }) {
        const id = `TC-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
        this.db.prepare(
            `INSERT INTO test_cases (id, issue_id, title, steps, expected, status, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, issueId, title, steps, expected, status, source, createdBy);
        this.recountTestCases(issueId);
        return this.getTestCase(id);
    }

    getTestCase(id) { return this.db.prepare('SELECT * FROM test_cases WHERE id = ?').get(id); }

    getTestCasesByIssue(issueId) {
        return this.db.prepare('SELECT * FROM test_cases WHERE issue_id = ? ORDER BY created_at ASC').all(issueId);
    }

    updateTestCase(id, updates) {
        const allowed = ['title', 'steps', 'expected', 'status'];
        const sets = [], vals = [];
        for (const [k, v] of Object.entries(updates)) {
            if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (sets.length === 0) return this.getTestCase(id);
        vals.push(id);
        this.db.prepare(`UPDATE test_cases SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return this.getTestCase(id);
    }

    deleteTestCase(id) {
        const tc = this.getTestCase(id);
        this.db.prepare('DELETE FROM test_cases WHERE id = ?').run(id);
        if (tc) this.recountTestCases(tc.issue_id);
    }

    recountTestCases(issueId) {
        const n = this.db.prepare('SELECT COUNT(*) as n FROM test_cases WHERE issue_id = ?').get(issueId).n;
        this.db.prepare('UPDATE issues SET test_cases_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(n, issueId);
    }

    // Sprint progress — completion % across its features plus rollup counts.
    getSprintProgress(sprintId) {
        const rows = this.db.prepare('SELECT dev_status, dev_percent, qa_status, open_bugs, critical_bugs FROM issues WHERE sprint_id = ?').all(sprintId);
        const total = rows.length;
        const done = rows.filter(r => r.dev_status === 'done').length;
        const inProgress = rows.filter(r => r.dev_status === 'in_progress' || r.dev_status === 'dev_completed').length;
        const todo = total - done - inProgress;
        // Sprint % = average of each feature's lifecycle completion (QA-driven), not raw Dev%.
        const avgPercent = total ? Math.round(rows.reduce((s, r) => s + this.featureCompletion(r), 0) / total) : 0;
        const passed = rows.filter(r => this.featureCompletion(r) === 100).length;
        const openBugs = rows.reduce((s, r) => s + (r.open_bugs || 0), 0);
        const criticalBugs = rows.reduce((s, r) => s + (r.critical_bugs || 0), 0);
        return { total, done, inProgress, todo, passed, percent: avgPercent, openBugs, criticalBugs };
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

    // ── PRDs ─────────────────────────────────────────────────
    createPrd({ title, description = '', s3Key = null, url = null, sprintId = null, issueId = null, createdBy = null }) {
        const id = `PRD-${Date.now().toString(36)}`;
        this.db.prepare(
            `INSERT INTO prds (id, title, description, s3_key, url, sprint_id, issue_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, title, description, s3Key, url, sprintId, issueId, createdBy);
        return this.getPrd(id);
    }

    getPrd(id) { return this.db.prepare('SELECT * FROM prds WHERE id = ?').get(id); }

    getAllPrds() {
        return this.db.prepare(`
            SELECT p.*, u.display_name as creator_name
            FROM prds p LEFT JOIN users u ON p.created_by = u.id
            ORDER BY p.created_at DESC
        `).all();
    }

    getPrdsBySprint(sprintId) {
        return this.db.prepare(`
            SELECT p.*, u.display_name as creator_name
            FROM prds p LEFT JOIN users u ON p.created_by = u.id
            WHERE p.sprint_id = ?
            ORDER BY p.created_at DESC
        `).all(sprintId);
    }

    updatePrd(id, updates) {
        const allowed = ['title', 'description', 's3_key', 'url', 'sprint_id', 'issue_id'];
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(updates)) {
            if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (sets.length === 0) return this.getPrd(id);
        sets.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(id);
        this.db.prepare(`UPDATE prds SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return this.getPrd(id);
    }

    deletePrd(id) {
        this.db.prepare('DELETE FROM prds WHERE id = ?').run(id);
    }

    // ── Pipeline (sessions + issues grouped by sprint) ───────────

    getAllPipelineSessions() {
        const rows = this.db.prepare(
            `SELECT s.id, s.task, s.status, s.model, s.sprint_id, s.stage,
                    s.design_session_id, s.dev_session_id, s.qa_session_id, s.prd_url,
                    s.type, s.labels,
                    s.created_at, s.updated_at, s.cost_usd, s.owner_id,
                    u.display_name as owner_name, u.email as owner_email
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             ORDER BY s.updated_at DESC`
        ).all();
        return rows.map(r => ({ ...r, labels: r.labels ? JSON.parse(r.labels) : [] }));
    }

    // Pipeline counts per sprint (sprintId NULL → Unassigned bucket).
    getPipelineCounts() {
        const issueCounts = this.db.prepare(
            `SELECT sprint_id, COUNT(*) as n FROM issues GROUP BY sprint_id`
        ).all();
        const sessionCounts = this.db.prepare(
            `SELECT sprint_id, COUNT(*) as n FROM sessions GROUP BY sprint_id`
        ).all();
        const map = new Map();
        const key = (sid) => sid || '__nosprint__';
        for (const r of issueCounts) {
            const k = key(r.sprint_id);
            if (!map.has(k)) map.set(k, { sprintId: r.sprint_id || null, issues: 0, sessions: 0 });
            map.get(k).issues = r.n;
        }
        for (const r of sessionCounts) {
            const k = key(r.sprint_id);
            if (!map.has(k)) map.set(k, { sprintId: r.sprint_id || null, issues: 0, sessions: 0 });
            map.get(k).sessions = r.n;
        }
        return Array.from(map.values());
    }

    // Paginated items for a single sprint bucket — newest first, union of issues + sessions.
    getPipelineGroupItems(sprintId, limit = 30, offset = 0) {
        const isNull = !sprintId;
        const issueRows = isNull
            ? this.db.prepare(
                `SELECT i.*, u.display_name as creator_name, a.display_name as assignee_name
                 FROM issues i
                 LEFT JOIN users u ON i.created_by = u.id
                 LEFT JOIN users a ON i.assigned_to = a.id
                 WHERE i.sprint_id IS NULL`
              ).all()
            : this.db.prepare(
                `SELECT i.*, u.display_name as creator_name, a.display_name as assignee_name
                 FROM issues i
                 LEFT JOIN users u ON i.created_by = u.id
                 LEFT JOIN users a ON i.assigned_to = a.id
                 WHERE i.sprint_id = ?`
              ).all(sprintId);

        const sessionRows = isNull
            ? this.db.prepare(
                `SELECT s.id, s.task, s.status, s.model, s.sprint_id, s.stage,
                        s.design_session_id, s.dev_session_id, s.qa_session_id, s.prd_url,
                        s.type, s.labels, s.updated_at, s.created_at,
                        u.display_name as owner_name, u.email as owner_email
                 FROM sessions s
                 LEFT JOIN users u ON s.owner_id = u.id
                 WHERE s.sprint_id IS NULL`
              ).all()
            : this.db.prepare(
                `SELECT s.id, s.task, s.status, s.model, s.sprint_id, s.stage,
                        s.design_session_id, s.dev_session_id, s.qa_session_id, s.prd_url,
                        s.type, s.labels, s.updated_at, s.created_at,
                        u.display_name as owner_name, u.email as owner_email
                 FROM sessions s
                 LEFT JOIN users u ON s.owner_id = u.id
                 WHERE s.sprint_id = ?`
              ).all(sprintId);

        const parseLabels = (v) => {
            if (Array.isArray(v)) return v;
            if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
            return [];
        };
        const issues = issueRows.map(iss => ({
            kind: 'issue',
            id: iss.id,
            title: iss.title,
            description: iss.description,
            type: iss.type || 'task',
            labels: parseLabels(iss.labels),
            category: iss.category || 'issue',
            stage: iss.stage || 'idea',
            status: iss.status,
            priority: iss.priority,
            session_id: iss.session_id,
            design_session_id: iss.design_session_id,
            qa_session_id: iss.qa_session_id,
            prd_url: iss.prd_url,
            sprint_id: iss.sprint_id,
            creator_name: iss.creator_name,
            assignee_name: iss.assignee_name,
            updated_at: iss.updated_at,
        }));
        const sessions = sessionRows.map(s => ({
            kind: 'session',
            id: s.id,
            title: s.task || 'Untitled session',
            type: s.type || 'task',
            labels: parseLabels(s.labels),
            stage: s.stage || 'idea',
            status: s.status,
            session_id: s.id,
            design_session_id: s.design_session_id,
            dev_session_id: s.dev_session_id,
            qa_session_id: s.qa_session_id,
            prd_url: s.prd_url,
            sprint_id: s.sprint_id,
            owner_name: s.owner_name,
            model: s.model,
            updated_at: s.updated_at,
        }));

        const all = [...issues, ...sessions].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const total = all.length;
        return { items: all.slice(offset, offset + limit), total };
    }

    // ── Session share links ─────────────────────────────────────
    createShareLink({ sessionId, token, createdBy, permission = 'write', expiresAt = null }) {
        const id = 'shl_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        this.db.prepare(
            `INSERT INTO session_share_links (id, session_id, token, permission, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, sessionId, token, permission, createdBy, expiresAt);
        return this.getShareLinkById(id);
    }

    getShareLinkById(id) {
        return this.db.prepare(`SELECT * FROM session_share_links WHERE id = ?`).get(id);
    }

    getShareLinkByToken(token) {
        return this.db.prepare(`SELECT * FROM session_share_links WHERE token = ?`).get(token);
    }

    listShareLinks(sessionId) {
        return this.db.prepare(
            `SELECT sl.*, u.display_name as creator_name, u.email as creator_email
             FROM session_share_links sl
             LEFT JOIN users u ON sl.created_by = u.id
             WHERE sl.session_id = ?
             ORDER BY sl.created_at DESC`
        ).all(sessionId);
    }

    revokeShareLink(id) {
        this.db.prepare(`UPDATE session_share_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    }

    incrementShareLinkUse(id) {
        this.db.prepare(`UPDATE session_share_links SET used_count = used_count + 1 WHERE id = ?`).run(id);
    }

    getSessionStore() { return this.db; }
}

export default SessionStore;
