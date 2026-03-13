// ============================================================
// supabase_store.js — Supabase-backed session & user persistence
// Same interface as SessionStore (SQLite) for drop-in swap
// ============================================================

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import config from './config.js';

class SupabaseStore {
    constructor() {
        this.supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
        this._initDone = this._init();
    }

    async _init() {
        // Tables must be created in Supabase beforehand via setup SQL
        // Just verify connectivity
        const { error } = await this.supabase.from('sessions').select('id').limit(1);
        if (error && error.code === '42P01') {
            throw new Error(
                'Supabase tables not found. Run the setup SQL first:\n' +
                '  node supabase_setup.js'
            );
        }
    }

    async ready() { return this._initDone; }

    // ── Sessions ──────────────────────────────────────────────

    createSession(id, userPhone, task, claudeSessionId, workingDir, ownerId = null, model = 'opus') {
        return this.supabase.from('sessions').upsert({
            id, user_phone: String(userPhone), owner_id: ownerId, task,
            claude_session_id: claudeSessionId, status: 'running',
            working_dir: workingDir, thread_open: true, model,
            cost_usd: 0, subscribers: '[]',
        });
    }

    async getSession(id) {
        const { data } = await this.supabase.from('sessions').select('*').eq('id', id).single();
        return data ? this._mapSession(data) : undefined;
    }

    async getActiveSessions(userPhone) {
        const cutoff = new Date(Date.now() - 86400000).toISOString();
        const { data } = await this.supabase.from('sessions')
            .select('*')
            .eq('user_phone', String(userPhone))
            .or(`status.eq.running,and(status.eq.stopped,updated_at.gte.${cutoff})`)
            .order('updated_at', { ascending: false });
        return (data || []).map(this._mapSession);
    }

    async getCurrentThread(userPhone) {
        const { data } = await this.supabase.from('sessions')
            .select('*')
            .eq('user_phone', String(userPhone))
            .eq('thread_open', true)
            .not('claude_session_id', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();
        return data ? this._mapSession(data) : undefined;
    }

    async updateSession(id, updates) {
        const mapped = { ...updates, updated_at: new Date().toISOString() };
        if (mapped.subscribers_arr) {
            mapped.subscribers = JSON.stringify(mapped.subscribers_arr);
            delete mapped.subscribers_arr;
        }
        await this.supabase.from('sessions').update(mapped).eq('id', id);
    }

    async getAllActiveSessions() {
        const { data } = await this.supabase.from('sessions')
            .select('*, users!sessions_owner_id_fkey(display_name, email)')
            .eq('status', 'running')
            .order('updated_at', { ascending: false });
        return (data || []).map(r => ({
            ...this._mapSession(r),
            owner_name: r.users?.display_name || null,
            owner_email: r.users?.email || null,
        }));
    }

    async getTotalCost() {
        const { data } = await this.supabase.rpc('sum_session_cost');
        return data || 0;
    }

    async getSessionsForUser(userId, limit = 20, offset = 0) {
        const { data } = await this.supabase.rpc('get_sessions_for_user', {
            p_user_id: userId, p_limit: limit, p_offset: offset
        });
        return (data || []).map(this._mapSession);
    }

    async getAllSessions(limit = 20, offset = 0) {
        const { data } = await this.supabase.from('sessions')
            .select('*, users!sessions_owner_id_fkey(display_name, email)')
            .order('updated_at', { ascending: false })
            .range(offset, offset + limit - 1);
        return (data || []).map(r => ({
            ...this._mapSession(r),
            owner_name: r.users?.display_name || null,
            owner_email: r.users?.email || null,
        }));
    }

    async countAllSessions() {
        const { count } = await this.supabase.from('sessions').select('*', { count: 'exact', head: true });
        return count || 0;
    }

    async setSessionStatus(id, status) {
        await this.supabase.from('sessions').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    }

    async closeThreadsForPhone(userPhone) {
        await this.supabase.from('sessions')
            .update({ thread_open: false, updated_at: new Date().toISOString() })
            .eq('user_phone', String(userPhone))
            .eq('thread_open', true);
    }

    closeThread(userPhone) { return this.closeThreadsForPhone(userPhone); }

    async cleanOrphanedSessions() {
        const { data } = await this.supabase.from('sessions')
            .update({ status: 'stopped' })
            .eq('status', 'running')
            .select('id');
        return data?.length || 0;
    }

    async incrementCost(id, delta) {
        const session = await this.getSession(id);
        if (!session) return;
        await this.supabase.from('sessions').update({
            cost_usd: (session.cost_usd || 0) + delta,
            updated_at: new Date().toISOString()
        }).eq('id', id);
    }

    // ── Messages ──────────────────────────────────────────────

    async addMessage(sessionId, role, content) {
        await this.supabase.from('messages').insert({ session_id: sessionId, role, content });
    }

    async upsertLastAssistantMessage(sessionId, content) {
        const { data } = await this.supabase.from('messages')
            .select('id, role')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: false })
            .limit(1)
            .single();
        if (data && data.role === 'assistant') {
            await this.supabase.from('messages').update({ content, timestamp: new Date().toISOString() }).eq('id', data.id);
        } else {
            await this.addMessage(sessionId, 'assistant', content);
        }
    }

    async getMessages(sessionId, limit = 20) {
        const { data } = await this.supabase.from('messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: false })
            .limit(limit);
        return (data || []).reverse();
    }

    // ── Phones ────────────────────────────────────────────────

    async getAllowedPhones() {
        const { data } = await this.supabase.from('allowed_phones')
            .select('*, users(email, display_name)')
            .order('added_at', { ascending: false });
        return (data || []).map(r => ({
            ...r, user_email: r.users?.email, user_name: r.users?.display_name, users: undefined,
        }));
    }

    async isPhoneAllowed(phone) {
        const { data } = await this.supabase.from('allowed_phones').select('phone').eq('phone', String(phone)).single();
        return !!data;
    }

    async addAllowedPhone(phone, label = '', userId = null) {
        await this.supabase.from('allowed_phones').upsert({ phone: String(phone), label, user_id: userId });
    }

    async removeAllowedPhone(phone) {
        await this.supabase.from('allowed_phones').delete().eq('phone', String(phone));
    }

    async seedAllowedPhones(phones) {
        const rows = phones.map(p => ({ phone: String(p).trim(), label: 'seed' }));
        await this.supabase.from('allowed_phones').upsert(rows, { onConflict: 'phone', ignoreDuplicates: true });
    }

    // ── Users ─────────────────────────────────────────────────

    async createUser({ email, phone, displayName, role = 'developer', isAdmin = 0, passwordHash = null, createdBy = null }) {
        const id = crypto.randomUUID();
        await this.supabase.from('users').insert({
            id, email: email || null, phone: phone || null,
            display_name: displayName || email?.split('@')[0] || phone || 'User',
            role, is_admin: isAdmin ? true : false,
            password_hash: passwordHash, created_by: createdBy,
        });
        return this.getUserById(id);
    }

    async getUserById(id) {
        const { data } = await this.supabase.from('users').select('*').eq('id', id).single();
        return data ? this._mapUser(data) : undefined;
    }

    async getUserByEmail(email) {
        const { data } = await this.supabase.from('users').select('*').eq('email', email?.toLowerCase().trim()).single();
        return data ? this._mapUser(data) : undefined;
    }

    async getUserByPhone(phone) {
        const { data } = await this.supabase.from('users').select('*').eq('phone', String(phone)).single();
        return data ? this._mapUser(data) : undefined;
    }

    async updateUserPassword(userId, passwordHash) {
        await this.supabase.from('users').update({ password_hash: passwordHash }).eq('id', userId);
    }

    async deleteUser(userId) {
        await this.supabase.from('users').delete().eq('id', userId);
    }

    async linkPhoneToUser(userId, phone) {
        await this.supabase.from('users').update({ phone: null }).eq('phone', String(phone)).neq('id', userId);
        await this.supabase.from('users').update({ phone: String(phone) }).eq('id', userId);
        await this.supabase.from('allowed_phones').update({ user_id: userId }).eq('phone', String(phone));
    }

    async getAllUsers() {
        const { data } = await this.supabase.from('users')
            .select('id, email, phone, display_name, role, is_admin, created_at, created_by')
            .order('created_at', { ascending: false });
        return (data || []).map(this._mapUser);
    }

    async getAdmins() {
        const { data } = await this.supabase.from('users').select('*').eq('is_admin', true);
        return (data || []).map(this._mapUser);
    }

    static hashPassword(plain) {
        const salt = 'wa-engineer-salt-2025';
        return crypto.createHash('sha256').update(salt + plain).digest('hex');
    }

    async verifyPassword(email, plain) {
        const user = await this.getUserByEmail(email);
        if (!user || !user.password_hash) return null;
        const hash = SupabaseStore.hashPassword(plain);
        if (user.password_hash !== hash) return null;
        return user;
    }

    // ── Collaborators ─────────────────────────────────────────

    async addCollaborator(sessionId, userId) {
        await this.supabase.from('session_collaborators').upsert({ session_id: sessionId, user_id: userId });
    }

    async removeCollaborator(sessionId, userId) {
        await this.supabase.from('session_collaborators').delete().eq('session_id', sessionId).eq('user_id', userId);
    }

    async isCollaborator(sessionId, userId) {
        const { data } = await this.supabase.from('session_collaborators')
            .select('session_id').eq('session_id', sessionId).eq('user_id', userId).single();
        return !!data;
    }

    async getCollaborators(sessionId) {
        const { data } = await this.supabase.from('session_collaborators')
            .select('*, users(id, email, phone, display_name)')
            .eq('session_id', sessionId);
        return (data || []).map(r => ({
            id: r.users?.id, email: r.users?.email,
            phone: r.users?.phone, display_name: r.users?.display_name,
            granted_at: r.granted_at,
        }));
    }

    // ── Access Requests ───────────────────────────────────────

    async createAccessRequest(sessionId, requesterId, requesterName, requesterEmail, note = '') {
        const id = crypto.randomUUID();
        await this.supabase.from('access_requests').insert({
            id, session_id: sessionId, requester_id: requesterId,
            requester_name: requesterName, requester_email: requesterEmail, note,
        });
        return id;
    }

    async getPendingAccessRequests() {
        const { data } = await this.supabase.from('access_requests')
            .select('*, sessions(task, updated_at)')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        return (data || []).map(r => ({
            ...r, session_task: r.sessions?.task, session_updated: r.sessions?.updated_at, sessions: undefined,
        }));
    }

    async countPendingRequests() {
        const { count } = await this.supabase.from('access_requests')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');
        return count || 0;
    }

    async resolveAccessRequest(requestId, resolvedBy, approve = true) {
        const status = approve ? 'approved' : 'rejected';
        await this.supabase.from('access_requests').update({
            status, resolved_at: new Date().toISOString(), resolved_by: resolvedBy
        }).eq('id', requestId);
        if (approve) {
            const { data } = await this.supabase.from('access_requests').select('*').eq('id', requestId).single();
            if (data) await this.addCollaborator(data.session_id, data.requester_id);
        }
    }

    // ── Issues ────────────────────────────────────────────────

    async createIssue({ title, description = '', priority = 'medium', labels = [], createdBy = null }) {
        const id = `ISS-${Date.now().toString(36)}`;
        const { data: maxRow } = await this.supabase.from('issues')
            .select('sort_order').eq('status', 'todo')
            .order('sort_order', { ascending: false }).limit(1).single();
        const sortOrder = (maxRow?.sort_order || 0) + 1;
        await this.supabase.from('issues').insert({
            id, title, description, priority,
            labels: JSON.stringify(labels), created_by: createdBy, sort_order: sortOrder,
        });
        return this.getIssue(id);
    }

    async getIssue(id) {
        const { data } = await this.supabase.from('issues').select('*').eq('id', id).single();
        return data || undefined;
    }

    async getAllIssues() {
        const { data } = await this.supabase.from('issues')
            .select('*, users!issues_created_by_fkey(display_name)')
            .order('sort_order', { ascending: true });
        return (data || []).map(r => ({
            ...r, creator_name: r.users?.display_name || null, users: undefined,
        }));
    }

    async getIssuesByStatus(status) {
        const { data } = await this.supabase.from('issues')
            .select('*, users!issues_created_by_fkey(display_name)')
            .eq('status', status)
            .order('sort_order', { ascending: true });
        return (data || []).map(r => ({
            ...r, creator_name: r.users?.display_name || null, users: undefined,
        }));
    }

    async updateIssue(id, updates) {
        const mapped = { ...updates, updated_at: new Date().toISOString() };
        if (mapped.labels && Array.isArray(mapped.labels)) mapped.labels = JSON.stringify(mapped.labels);
        await this.supabase.from('issues').update(mapped).eq('id', id);
        return this.getIssue(id);
    }

    async deleteIssue(id) {
        await this.supabase.from('issues').delete().eq('id', id);
    }

    async getNextTodoIssue() {
        const { data } = await this.supabase.from('issues')
            .select('*').eq('status', 'todo')
            .order('sort_order', { ascending: true }).limit(1).single();
        return data || undefined;
    }

    async countIssuesByStatus() {
        const { data } = await this.supabase.rpc('count_issues_by_status');
        return data || [];
    }

    // ── System Prompts ────────────────────────────────────────

    async getSystemPrompt(key) {
        const { data } = await this.supabase.from('system_prompts').select('*').eq('key', key).single();
        return data || undefined;
    }

    async setSystemPrompt(key, prompt, updatedBy = null) {
        await this.supabase.from('system_prompts').upsert({
            key, prompt, updated_at: new Date().toISOString(), updated_by: updatedBy,
        });
    }

    async getAllSystemPrompts() {
        const { data } = await this.supabase.from('system_prompts').select('*').order('key');
        return data || [];
    }

    getSessionStore() { return this.supabase; }

    // ── Mapping helpers ───────────────────────────────────────

    _mapSession(row) {
        if (!row) return row;
        return {
            ...row,
            thread_open: row.thread_open === true ? 1 : row.thread_open === false ? 0 : row.thread_open,
        };
    }

    _mapUser(row) {
        if (!row) return row;
        return {
            ...row,
            is_admin: row.is_admin === true ? 1 : row.is_admin === false ? 0 : row.is_admin,
        };
    }
}

export default SupabaseStore;
