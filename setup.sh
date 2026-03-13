#!/bin/bash
# =============================================================
# setup.sh — WhatsApp AI Engineer — Interactive Setup Wizard
# =============================================================
set -e
cd "$(dirname "$0")"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
print_banner() {
    echo ""; echo -e "${BLUE}${BOLD}"
    echo "  ╬════════════════════════════════════════════╬"
    echo "  ║      WhatsApp AI Engineer — Setup Wizard     ║"
    echo "  ╚════════════════════════════════════════════╝"
    echo -e "${NC}"
}
step() { echo -e "\n${BLUE}${BOLD}Step $1: $2${NC}"; }
ok()   { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
fail() { echo -e "${RED}$1${NC}"; exit 1; }

install_gum() {
    if command -v gum &>/dev/null; then return; fi
    warn "gum not found — installing..."
    if command -v apt-get &>/dev/null; then
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null
        echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list > /dev/null
        sudo apt-get update -q && sudo apt-get install -y -q gum
    elif command -v brew &>/dev/null; then
        brew install gum
    else
        GUM_VERSION="0.14.5"
        curl -fsSL "https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_linux_amd64.tar.gz" | sudo tar -xz -C /usr/local/bin gum
    fi
    ok "gum installed"
}

install_deps() {
    step 1 "Install Node.js Dependencies"
    if ! command -v node &>/dev/null; then
        fail "Node.js not found! Install Node.js 18+"
    fi
    ok "Node.js $(node -v) found"
    gum spin --spinner dot --title "Installing npm packages..." -- npm install
    ok "npm packages installed"
    npm rebuild node-pty 2>/dev/null && ok "Native modules ready" || warn "node-pty rebuild failed"
}

check_claude() {
    step 2 "Check Claude Code Installation"
    CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
    if [ -z "$CLAUDE_BIN" ]; then
        warn "Claude Code not found."
        if gum confirm "Install Claude Code now?"; then
            curl -fsSL https://claude.ai/install.sh | bash || npm install -g @anthropic-ai/claude-code 2>/dev/null || {
                warn "Auto-install failed. Install manually: https://claude.ai/install"
            }
            CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
        else
            CLAUDE_BIN="$HOME/.local/bin/claude"
        fi
    fi
    ok "Claude binary: ${CLAUDE_BIN}"
    if "$CLAUDE_BIN" --version &>/dev/null; then
        ok "Claude Code is authenticated"
    else
        warn "Claude may not be authenticated. Run: claude auth login"
    fi
}

choose_mode() {
    step 3 "Choose Access Mode"
    gum style --foreground 212 --bold "How do you want users to interact?"
    ACCESS_MODE=$(gum choose "WhatsApp (QR scan)" "Email (dashboard only)" "Both")
    case "$ACCESS_MODE" in
        "WhatsApp (QR scan)") ok "WhatsApp mode selected." ;;
        "Email (dashboard only)") ok "Email-only mode selected." ;;
        "Both") ok "Both modes selected." ;;
    esac
}

configure_env() {
    step 4 "Configure Environment Variables"
    if [ -f .env ]; then
        if ! gum confirm ".env already exists. Reconfigure it?"; then ok "Keeping existing .env"; return 0; fi
    fi

    echo -e "${BLUE}I'll ask a few questions to build your .env file.${NC}\n"

    # ── Database Backend ──────────────────────────────────
    gum style --foreground 212 --bold "Database Backend"
    DB_BACKEND=$(gum choose "SQLite (local file — zero setup)" "Supabase (cloud PostgreSQL)")

    DB_BACKEND_VAL="sqlite"
    SUPABASE_URL_VAL=""
    SUPABASE_SERVICE_KEY_VAL=""
    SUPABASE_ANON_KEY_VAL=""

    if [ "$DB_BACKEND" = "Supabase (cloud PostgreSQL)" ]; then
        DB_BACKEND_VAL="supabase"
        ok "Supabase selected."
        echo ""
        gum style --foreground 147 "Get these from: Supabase Dashboard → Settings → API"
        echo ""

        gum style --foreground 212 --bold "Supabase Project URL"
        SUPABASE_URL_VAL=$(gum input --placeholder "https://your-project.supabase.co")
        [ -z "$SUPABASE_URL_VAL" ] && fail "Supabase URL is required."

        gum style --foreground 212 --bold "Supabase Service Role Key"
        gum style --foreground 245 "  Settings → API → service_role (secret)"
        SUPABASE_SERVICE_KEY_VAL=$(gum input --password --placeholder "eyJhbGciOiJIUzI1NiIs...")
        [ -z "$SUPABASE_SERVICE_KEY_VAL" ] && fail "Supabase service role key is required."

        gum style --foreground 212 --bold "Supabase Anon Key (optional)"
        gum style --foreground 245 "  Settings → API → anon (public)"
        SUPABASE_ANON_KEY_VAL=$(gum input --placeholder "Leave empty to skip")

        # Install supabase-js if not present
        if ! node -e "require('@supabase/supabase-js')" 2>/dev/null; then
            gum spin --spinner dot --title "Installing @supabase/supabase-js..." -- npm install @supabase/supabase-js
            ok "@supabase/supabase-js installed"
        fi

        # Test connection
        echo ""
        gum spin --spinner dot --title "Testing Supabase connection..." -- node -e "
            import { createClient } from '@supabase/supabase-js';
            const sb = createClient('${SUPABASE_URL_VAL}', '${SUPABASE_SERVICE_KEY_VAL}');
            const { error } = await sb.from('sessions').select('id').limit(1);
            if (error && error.code !== '42P01') { console.error(error.message); process.exit(1); }
        " 2>/tmp/sb-check.log && {
            ok "Supabase connection successful!"
        } || {
            SB_ERR=$(cat /tmp/sb-check.log 2>/dev/null)
            warn "Supabase connection failed: ${SB_ERR:-unknown error}"
            if ! gum confirm "Continue anyway?"; then fail "Fix Supabase credentials and retry."; fi
        }
        rm -f /tmp/sb-check.log
    else
        DB_BACKEND_VAL="sqlite"
        ok "SQLite selected — data stored in ./sessions.db"
    fi

    echo ""

    # ── Core Config ───────────────────────────────────────
    gum style --foreground 212 --bold "Gemini API Key (required)"
    GEMINI_KEY=$(gum input --placeholder "AIza...")
    [ -z "$GEMINI_KEY" ] && fail "Gemini API key is required."

    gum style --foreground 212 --bold "Admin Email"
    ADMIN_EMAIL=$(gum input --placeholder "admin@yourcompany.com")
    [ -z "$ADMIN_EMAIL" ] && fail "Admin email is required."

    gum style --foreground 212 --bold "Admin Display Name"
    ADMIN_NAME=$(gum input --placeholder "Admin")
    [ -z "$ADMIN_NAME" ] && ADMIN_NAME="Admin"

    ALLOWED_PHONES_VAL=""
    if [ "$ACCESS_MODE" != "Email (dashboard only)" ]; then
        gum style --foreground 212 --bold "Allowed WhatsApp numbers (comma-separated, with country code)"
        ALLOWED_PHONES_VAL=$(gum input --placeholder "91997XXXXXXX,91998XXXXXXX")
    fi

    gum style --foreground 212 --bold "JWT Secret (auto-generated if left empty)"
    JWT_DEFAULT="$(openssl rand -hex 32 2>/dev/null || echo "change-me-$(date +%s)")"
    JWT_SECRET=$(gum input --placeholder "Leave empty for auto-generated")
    [ -z "$JWT_SECRET" ] && JWT_SECRET="$JWT_DEFAULT"

    SMTP_USER=""; SMTP_PASS=""; SMTP_HOST="smtp.gmail.com"
    if [ "$ACCESS_MODE" != "WhatsApp (QR scan)" ]; then
        gum style --foreground 212 --bold "SMTP Email"
        SMTP_USER=$(gum input --placeholder "you@gmail.com")
        gum style --foreground 212 --bold "SMTP App Password"
        SMTP_PASS=$(gum input --password --placeholder "your-app-password")
        gum style --foreground 212 --bold "SMTP Host [smtp.gmail.com]"
        SMTP_HOST_INPUT=$(gum input --placeholder "smtp.gmail.com")
        [ -n "$SMTP_HOST_INPUT" ] && SMTP_HOST="$SMTP_HOST_INPUT"
    fi

    gum style --foreground 212 --bold "Default Claude working directory [/home/ubuntu]"
    WORKING_DIR=$(gum input --placeholder "/home/ubuntu")
    [ -z "$WORKING_DIR" ] && WORKING_DIR="/home/ubuntu"

    CLAUDE_BIN_PATH=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
    gum style --foreground 212 --bold "Claude binary path [$CLAUDE_BIN_PATH]"
    CLAUDE_BIN_INPUT=$(gum input --placeholder "$CLAUDE_BIN_PATH")
    [ -z "$CLAUDE_BIN_INPUT" ] && CLAUDE_BIN_INPUT="$CLAUDE_BIN_PATH"

    WA_ENABLED="true"
    [ "$ACCESS_MODE" = "Email (dashboard only)" ] && WA_ENABLED="false"

    # ── Write .env ────────────────────────────────────────
    cat > .env << EOF
# WhatsApp AI Engineer — Environment Configuration
# Generated by setup.sh on $(date)

GEMINI_API_KEY=$GEMINI_KEY
GEMINI_MODEL=gemini-3-flash-preview
CLAUDE_BIN=$CLAUDE_BIN_INPUT

ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_NAME=$ADMIN_NAME

ALLOWED_PHONES=$ALLOWED_PHONES_VAL

JWT_SECRET=$JWT_SECRET
SMTP_HOST=$SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS

DEFAULT_WORKING_DIR=$WORKING_DIR
AUTH_DIR=./auth_info
LOG_DIR=./logs

WHATSAPP_ENABLED=$WA_ENABLED

# ── Database ──────────────────────────────────────────
# Options: sqlite | supabase
DB_BACKEND=$DB_BACKEND_VAL
DB_PATH=./sessions.db
EOF

    if [ "$DB_BACKEND_VAL" = "supabase" ]; then
        cat >> .env << EOF

# ── Supabase ─────────────────────────────────────────
SUPABASE_URL=$SUPABASE_URL_VAL
SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY_VAL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY_VAL
EOF
    fi

    chmod 600 .env
    ok ".env created (chmod 600)"

    # If Supabase, offer to create tables
    if [ "$DB_BACKEND_VAL" = "supabase" ]; then
        echo ""
        if gum confirm "Create Supabase tables now?"; then
            node supabase_setup.js || warn "Auto-setup had issues — check Supabase SQL Editor"
        else
            warn "Run later: node supabase_setup.js"
        fi
    fi
}

start_service() {
    step 5 "Start the Service"
    if gum confirm "Start WhatsApp AI Engineer now?"; then
        bash ./start.sh
        ok "Started! Run: tail -f /tmp/wa-engineer.log"
        echo ""
        echo -e "${GREEN}${BOLD}Setup complete!${NC}"
        echo -e "  Dashboard: ${BLUE}http://localhost:18790${NC}"
        if [ "$ACCESS_MODE" != "WhatsApp (QR scan)" ]; then
            echo -e "  Login:     ${BLUE}http://localhost:18790/login.html${NC}"
        fi
        echo -e "  Logs:      tail -f /tmp/wa-engineer.log"
        echo -e "  Database:  ${BLUE}${DB_BACKEND_VAL:-sqlite}${NC}"
        echo ""
    else
        echo -e "\n${YELLOW}Run ./start.sh when ready.${NC}\n"
    fi
}

print_banner
install_gum
install_deps
check_claude
choose_mode
configure_env
start_service
