// ============================================================
// config.js — Central configuration for WhatsApp Engineer
// ============================================================

const config = {
    // Path to Claude Code binary
    CLAUDE_BIN: process.env.CLAUDE_BIN || '/home/ubuntu/.local/bin/claude',

    // OpenAI Codex CLI — a second agent binary, not another API endpoint. Selecting a
    // `codex:` model runs that session through `codex exec` instead of `claude`.
    // Auth is the CLI's own (`codex login` → $CODEX_HOME/auth.json). We never set
    // CODEX_API_KEY, so a ChatGPT plan subscription is used when one is signed in.
    CODEX_BIN: process.env.CODEX_BIN || '/home/ubuntu/.local/bin/codex',
    CODEX_HOME: process.env.CODEX_HOME || '/home/ubuntu/.codex',

    // Ollama fallback (per-session model switch). Ollama exposes an
    // Anthropic-compatible API; selecting an `ollama:` model routes that session here.
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    OLLAMA_AUTH_TOKEN: process.env.OLLAMA_AUTH_TOKEN || 'ollama',

    // Headroom context-compression proxy. When the admin toggle is ON and the
    // proxy is reachable, Claude sessions route through it (compress → Anthropic).
    HEADROOM_BASE_URL: process.env.HEADROOM_BASE_URL || 'http://localhost:8787',

    // xAI Grok fallback (per-session model switch). xAI's API is OpenAI-schema, not
    // Anthropic-schema, so unlike Ollama it can't be pointed at directly — selecting
    // a `grok:` model routes that session through grok_proxy.js, a local translation
    // proxy mounted inside this app's own Express server.
    GROK_API_KEY: process.env.GROK_API_KEY || '',
    GROK_API_BASE_URL: process.env.GROK_API_BASE_URL || 'https://api.x.ai/v1',
    // ponytail: exact xAI model slug for "Grok 4.5" unconfirmed as of writing — override
    // via env once the real slug is known from api.x.ai's model list.
    GROK_MODEL: process.env.GROK_MODEL || 'grok-4.5',
    // Shared secret the proxy checks on incoming requests (not the real xAI key —
    // that's injected server-side and never reaches the spawned `claude` process).
    GROK_PROXY_TOKEN: process.env.GROK_PROXY_TOKEN || 'grok-local-proxy-token',
    GROK_PROXY_PORT: parseInt(process.env.PORT || '18790'),

    // Gemini API
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    // Allowed phone numbers (admin seed — also manageable via dashboard)
    ALLOWED_PHONES: (process.env.ALLOWED_PHONES || '').split(',').filter(Boolean),

    // Allowed WhatsApp group JIDs
    ALLOWED_GROUPS: (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean),

    // Bot aliases for group @mentions
    BOT_ALIASES: (process.env.BOT_ALIASES || 'Koach,PLBot').split(',').filter(Boolean),

    // Session defaults
    DEFAULT_WORKING_DIR: process.env.DEFAULT_WORKING_DIR || '/home/ubuntu',
    MAX_MESSAGE_LENGTH: 4000,
    CLAUDE_SESSION_TIMEOUT: 30 * 60 * 1000,

    // Knowledge Base — GitHub repo (pluginlive-kb), cloned locally. No Outline.
    KB_DIR: process.env.KB_DIR || '/home/ubuntu/pluginlive-kb',

    // Design workspace — design-mode sessions run here (separate CLAUDE.md + deploy flow)
    DESIGNS_DIR: process.env.DESIGNS_DIR || '/home/ubuntu/pluginlive-designs',

    // Database backend: 'sqlite' (default) or 'supabase'
    DB_BACKEND: process.env.DB_BACKEND || 'sqlite',

    // Paths (SQLite mode)
    AUTH_DIR: process.env.AUTH_DIR || './auth_info',
    DB_PATH: process.env.DB_PATH || './sessions.db',
    LOG_DIR: process.env.LOG_DIR || './logs',

    // Supabase (when DB_BACKEND=supabase)
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',

    // ── Auth (JWT + Email/Nodemailer) ─────────────────────────
    JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production-please',

    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587'),
    SMTP_SECURE: process.env.SMTP_SECURE === 'true', // true for port 465
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',

    // ── Google Sheets (Sprint Board: Open in Sheet / Template / Upload) ──
    // Service-account auth. Provide ONE of:
    //   GOOGLE_SERVICE_ACCOUNT_FILE — path to the service-account JSON key, or
    //   GOOGLE_SERVICE_ACCOUNT_JSON — the JSON key contents inline.
    // Enable the Google Sheets API + Drive API on that service account's project.
    GOOGLE_SERVICE_ACCOUNT_FILE: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    // Optional: share new sheets with this email/domain (e.g. your workspace) and/or
    // create them inside this Drive folder.
    GOOGLE_SHEETS_SHARE_WITH: process.env.GOOGLE_SHEETS_SHARE_WITH || '',
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',

    // Base path when served under a sub-path (e.g., /sessions)
    // Leave empty '' when served at root /
    BASE_PATH: (process.env.BASE_PATH || '').replace(/\/$/, ''),

    // Set to false to disable WhatsApp entirely (email-only mode)
    WHATSAPP_ENABLED: process.env.WHATSAPP_ENABLED !== 'false',

    // First admin account seeded on first boot
    ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
    ADMIN_NAME: process.env.ADMIN_NAME || 'Admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
};

// Session cookie name, namespaced per instance.
// Cookies are scoped by host and ignore the port, so several instances of this app
// on the same machine share one browser cookie jar — a login on :18793 used to
// overwrite the :18790 login. BASE_PATH is what distinguishes the instances, so
// derive the name from it. The path stays '/' on purpose: the /ws and /term
// WebSocket upgrades are mounted at the root, not under BASE_PATH, so a
// path-scoped cookie would never reach them.
const basePathSlug = config.BASE_PATH.replace(/[^a-zA-Z0-9]/g, '');
config.COOKIE_NAME = basePathSlug ? `wa_token_${basePathSlug}` : 'wa_token';

export default config;
