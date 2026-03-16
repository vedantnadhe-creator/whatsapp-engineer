import Database from 'better-sqlite3';
const db = new Database('sessions.db');
console.log(db.prepare('SELECT id, claude_session_id, status FROM sessions WHERE id=?').get('WA-mm362a3f'));
