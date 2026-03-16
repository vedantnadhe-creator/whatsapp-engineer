import Database from 'better-sqlite3';
const db = new Database('sessions.db');
const update = db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ? OR id = ?');
const res = update.run('329424e5-fd01-40b1-a759-d60caeee92c2', 'WA-mm362a3f', 'WA-plan-mm2huef8');
console.log('Updated rows:', res.changes);
