// ============================================================
// store_factory.js — Returns SQLite or Supabase store based on config
// ============================================================

import config from './config.js';

export async function createStore() {
    if (config.DB_BACKEND === 'supabase') {
        if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
            throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required when DB_BACKEND=supabase');
        }
        const { default: SupabaseStore } = await import('./supabase_store.js');
        const store = new SupabaseStore();
        await store.ready();
        console.log('📦 Database: Supabase');
        return store;
    }

    const { default: SessionStore } = await import('./session_store.js');
    const store = new SessionStore();
    console.log('📦 Database: SQLite');
    return store;
}
