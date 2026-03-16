import Database from 'better-sqlite3';
const db = new Database('sessions.db');
const rows = db.prepare('SELECT id, user_phone, claude_session_id, thread_open, status FROM sessions ORDER BY updated_at DESC LIMIT 5').all();
console.log(JSON.stringify(rows, null, 2));
