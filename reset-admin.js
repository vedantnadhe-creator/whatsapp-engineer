#!/usr/bin/env node
// Reset admin password — run: node reset-admin.js [new-password]
// If no password provided, generates one and prints it.

import crypto from 'crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
dotenv.config();

const DB_PATH = process.env.DB_PATH || './sessions.db';
const newPassword = process.argv[2] || crypto.randomBytes(9).toString('base64url');

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

try {
    const db = new Database(DB_PATH);
    const admins = db.prepare('SELECT id, email, display_name FROM users WHERE is_admin = 1').all();

    if (admins.length === 0) {
        console.log('No admin users found in database.');
        process.exit(1);
    }

    const hash = hashPassword(newPassword);
    for (const admin of admins) {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, admin.id);
        console.log(`\nReset password for: ${admin.display_name || admin.email} (${admin.email})`);
    }

    console.log(`\n  Email:    ${admins[0].email}`);
    console.log(`  Password: ${newPassword}`);
    console.log(`\n  Save this password! Use it to log in.\n`);
    db.close();
} catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
}
