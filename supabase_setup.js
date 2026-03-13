#!/usr/bin/env node
// ============================================================
// supabase_setup.js — Create all required tables in Supabase
// Run once: node supabase_setup.js
// ============================================================

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
}

const supabase = createClient(url, key);

const SETUP_SQL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_phone TEXT NOT NULL,
    owner_id TEXT,
    claude_session_id TEXT,
    task TEXT,
    status TEXT DEFAULT 'running',
    thread_open BOOLEAN DEFAULT TRUE,
    working_dir TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    cost_usd NUMERIC DEFAULT 0,
    subscribers TEXT DEFAULT '[]',
    model TEXT DEFAULT 'opus'
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_phone);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

-- Allowed phones
CREATE TABLE IF NOT EXISTS allowed_phones (
    phone TEXT PRIMARY KEY,
    label TEXT,
    user_id TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    display_name TEXT,
    role TEXT DEFAULT 'developer',
    is_admin BOOLEAN DEFAULT FALSE,
    password_hash TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Session collaborators
CREATE TABLE IF NOT EXISTS session_collaborators (
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_collaborators_session ON session_collaborators(session_id);
CREATE INDEX IF NOT EXISTS idx_collaborators_user ON session_collaborators(user_id);

-- Access requests
CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    requester_name TEXT,
    requester_email TEXT,
    status TEXT DEFAULT 'pending',
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);

-- Issues table
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_created_by ON issues(created_by);

-- System prompts
CREATE TABLE IF NOT EXISTS system_prompts (
    key TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by TEXT
);

-- Foreign key constraints (added as ALTER so they don't fail on re-run)
DO $$ BEGIN
    ALTER TABLE sessions ADD CONSTRAINT sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE issues ADD CONSTRAINT issues_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE allowed_phones ADD CONSTRAINT allowed_phones_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RPC: sum session cost
CREATE OR REPLACE FUNCTION sum_session_cost() RETURNS NUMERIC AS $$
    SELECT COALESCE(SUM(cost_usd), 0) FROM sessions;
$$ LANGUAGE sql;

-- RPC: count issues by status
CREATE OR REPLACE FUNCTION count_issues_by_status()
RETURNS TABLE(status TEXT, count BIGINT) AS $$
    SELECT status, COUNT(*) FROM issues GROUP BY status;
$$ LANGUAGE sql;

-- RPC: get sessions for user (with is_mine, has_access)
CREATE OR REPLACE FUNCTION get_sessions_for_user(p_user_id TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
    id TEXT, user_phone TEXT, owner_id TEXT, claude_session_id TEXT, task TEXT,
    status TEXT, thread_open BOOLEAN, working_dir TEXT, created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ, cost_usd NUMERIC, subscribers TEXT, model TEXT,
    owner_name TEXT, owner_email TEXT, is_mine INT, has_access INT
) AS $$
    SELECT s.*, u.display_name, u.email,
        CASE WHEN s.owner_id = p_user_id THEN 1 ELSE 0 END,
        CASE WHEN sc.user_id IS NOT NULL THEN 1 ELSE 0 END
    FROM sessions s
    LEFT JOIN users u ON s.owner_id = u.id
    LEFT JOIN session_collaborators sc ON sc.session_id = s.id AND sc.user_id = p_user_id
    ORDER BY s.updated_at DESC
    LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql;

-- Enable RLS (optional — disabled for service key)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

-- Allow full access for service role
CREATE POLICY IF NOT EXISTS "service_all_sessions" ON sessions FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_all_messages" ON messages FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_all_users" ON users FOR ALL USING (true);
CREATE POLICY IF NOT EXISTS "service_all_issues" ON issues FOR ALL USING (true);
`;

async function setup() {
    console.log('Setting up Supabase tables...');

    // Execute SQL via Supabase's pg_net or direct SQL
    const { error } = await supabase.rpc('exec_sql', { sql: SETUP_SQL }).catch(() => ({ error: 'rpc not available' }));

    if (error) {
        // Fallback: run statements individually
        console.log('Running setup SQL statements individually...');
        const statements = SETUP_SQL.split(';').map(s => s.trim()).filter(s => s.length > 5);

        let success = 0;
        let skipped = 0;
        for (const stmt of statements) {
            try {
                const { error: stmtErr } = await supabase.rpc('exec_sql', { sql: stmt + ';' });
                if (stmtErr) {
                    // Try the SQL editor approach
                    console.log(`  Note: "${stmt.substring(0, 60)}..." — may need manual execution`);
                    skipped++;
                } else {
                    success++;
                }
            } catch (e) {
                skipped++;
            }
        }

        if (skipped > 0) {
            console.log(`\n⚠️  ${skipped} statements need manual execution.`);
            console.log('Copy the SQL below and run it in your Supabase SQL Editor:\n');
            console.log('Dashboard → SQL Editor → New Query → Paste & Run\n');
            console.log('─'.repeat(60));
            console.log(SETUP_SQL);
            console.log('─'.repeat(60));
        }
        if (success > 0) {
            console.log(`\n✅ ${success} statements executed successfully.`);
        }
    } else {
        console.log('✅ All tables created successfully!');
    }
}

// Also export the SQL for manual use
export { SETUP_SQL };

setup().catch(console.error);
