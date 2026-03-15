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

HAS_GUM=false

install_gum() {
    if command -v gum &>/dev/null; then HAS_GUM=true; return; fi
    warn "gum not found — attempting install..."
    if command -v apt-get &>/dev/null; then
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null || true
        echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list > /dev/null
        sudo apt-get update -q 2>/dev/null && sudo apt-get install -y -q gum 2>/dev/null
    elif command -v brew &>/dev/null; then
        brew install gum 2>/dev/null
    else
        GUM_VERSION="0.14.5"
        curl -fsSL "https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_linux_amd64.tar.gz" | sudo tar -xz -C /usr/local/bin gum 2>/dev/null
    fi
    if command -v gum &>/dev/null; then
        HAS_GUM=true
        ok "gum installed"
    else
        warn "gum install failed — using fallback prompts (works fine)"
    fi
}

# ── Fallback helpers when gum is not available ──
prompt_input() {
    local label="$1" placeholder="$2" is_password="${3:-false}"
    echo -e "${BLUE}${BOLD}${label}${NC}"
    if [ -n "$placeholder" ]; then echo -e "  ${YELLOW}(${placeholder})${NC}"; fi
    if [ "$is_password" = "true" ]; then
        read -s -r -p "> " REPLY; echo
    else
        read -r -p "> " REPLY
    fi
    echo "$REPLY"
}

prompt_choose() {
    local label="$1"; shift
    local options=("$@")
    echo -e "${BLUE}${BOLD}${label}${NC}"
    local i=1
    for opt in "${options[@]}"; do
        echo -e "  ${i}) ${opt}"
        ((i++))
    done
    read -r -p "Choose [1-${#options[@]}]: " choice
    local idx=$((choice - 1))
    if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#options[@]}" ]; then
        echo "${options[$idx]}"
    else
        echo "${options[0]}"
    fi
}

prompt_confirm() {
    local label="$1"
    read -r -p "${label} [y/N]: " yn
    case "$yn" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

install_deps() {
    step 1 "Install Node.js Dependencies"
    if ! command -v node &>/dev/null; then
        fail "Node.js not found! Install Node.js 18+"
    fi
    ok "Node.js $(node -v) found"
    echo "Installing npm packages..."
    npm install
    ok "npm packages installed"
    npm rebuild node-pty 2>/dev/null && ok "Native modules ready" || warn "node-pty rebuild failed (optional)"
}

build_frontend() {
    step 2 "Build Frontend"
    if [ -d "public-react" ]; then
        echo "Building React dashboard..."
        (cd public-react && npm install && npm run build) && ok "Frontend built" || warn "Frontend build failed — dashboard may not work"
    else
        ok "No frontend to build"
    fi
}

check_claude() {
    step 3 "Check Claude Code Installation"
    CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
    if [ -z "$CLAUDE_BIN" ]; then
        warn "Claude Code not found."
        if $HAS_GUM && gum confirm "Install Claude Code now?"; then
            curl -fsSL https://claude.ai/install.sh | bash || npm install -g @anthropic-ai/claude-code 2>/dev/null || warn "Auto-install failed. Install manually: https://claude.ai/install"
            CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
        elif ! $HAS_GUM && prompt_confirm "Install Claude Code now?"; then
            curl -fsSL https://claude.ai/install.sh | bash || npm install -g @anthropic-ai/claude-code 2>/dev/null || warn "Auto-install failed. Install manually: https://claude.ai/install"
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
    step 4 "Choose Access Mode"
    local modes=("WhatsApp (QR scan)" "Email (dashboard only)" "Both")
    if $HAS_GUM; then
        ACCESS_MODE=$(gum choose "${modes[@]}")
    else
        ACCESS_MODE=$(prompt_choose "How do you want users to interact?" "${modes[@]}")
    fi
    ok "${ACCESS_MODE} selected."
}

configure_env() {
    step 5 "Configure Environment Variables"
    if [ -f .env ]; then
        if $HAS_GUM; then
            gum confirm ".env already exists. Reconfigure it?" || { ok "Keeping existing .env"; return 0; }
        else
            prompt_confirm ".env already exists. Reconfigure it?" || { ok "Keeping existing .env"; return 0; }
        fi
    fi

    echo -e "${BLUE}I'll ask a few questions to build your .env file.${NC}\n"

    # ── Database Backend ──────────────────────────────────
    local db_options=("SQLite (local file — zero setup)" "Supabase (cloud PostgreSQL)")
    if $HAS_GUM; then
        DB_BACKEND=$(gum choose "${db_options[@]}")
    else
        DB_BACKEND=$(prompt_choose "Database Backend" "${db_options[@]}")
    fi

    DB_BACKEND_VAL="sqlite"
    SUPABASE_URL_VAL=""
    SUPABASE_SERVICE_KEY_VAL=""
    SUPABASE_ANON_KEY_VAL=""

    if [ "$DB_BACKEND" = "Supabase (cloud PostgreSQL)" ]; then
        DB_BACKEND_VAL="supabase"
        ok "Supabase selected."
        echo -e "\n  Get these from: Supabase Dashboard → Settings → API\n"

        if $HAS_GUM; then
            gum style --foreground 212 --bold "Supabase Project URL"
            SUPABASE_URL_VAL=$(gum input --placeholder "https://your-project.supabase.co")
            gum style --foreground 212 --bold "Supabase Service Role Key"
            SUPABASE_SERVICE_KEY_VAL=$(gum input --password --placeholder "eyJhbGciOiJIUzI1NiIs...")
            gum style --foreground 212 --bold "Supabase Anon Key (optional)"
            SUPABASE_ANON_KEY_VAL=$(gum input --placeholder "Leave empty to skip")
        else
            SUPABASE_URL_VAL=$(prompt_input "Supabase Project URL" "https://your-project.supabase.co")
            SUPABASE_SERVICE_KEY_VAL=$(prompt_input "Supabase Service Role Key" "eyJhbGciOiJIUzI1NiIs..." true)
            SUPABASE_ANON_KEY_VAL=$(prompt_input "Supabase Anon Key (optional)" "Leave empty to skip")
        fi

        [ -z "$SUPABASE_URL_VAL" ] && fail "Supabase URL is required."
        [ -z "$SUPABASE_SERVICE_KEY_VAL" ] && fail "Supabase service role key is required."

        if ! node -e "require('@supabase/supabase-js')" 2>/dev/null; then
            echo "Installing @supabase/supabase-js..."
            npm install @supabase/supabase-js
            ok "@supabase/supabase-js installed"
        fi
    else
        DB_BACKEND_VAL="sqlite"
        ok "SQLite selected — data stored in ./sessions.db"
    fi

    echo ""

    # ── Core Config ───────────────────────────────────────
    if $HAS_GUM; then
        gum style --foreground 212 --bold "Gemini API Key (required)"
        GEMINI_KEY=$(gum input --placeholder "AIza...")
        gum style --foreground 212 --bold "Admin Email"
        ADMIN_EMAIL=$(gum input --placeholder "admin@yourcompany.com")
        gum style --foreground 212 --bold "Admin Display Name"
        ADMIN_NAME=$(gum input --placeholder "Admin")
    else
        GEMINI_KEY=$(prompt_input "Gemini API Key (required)" "AIza...")
        ADMIN_EMAIL=$(prompt_input "Admin Email" "admin@yourcompany.com")
        ADMIN_NAME=$(prompt_input "Admin Display Name" "Admin")
    fi

    [ -z "$GEMINI_KEY" ] && fail "Gemini API key is required."
    [ -z "$ADMIN_EMAIL" ] && fail "Admin email is required."
    [ -z "$ADMIN_NAME" ] && ADMIN_NAME="Admin"

    # Generate admin password
    ADMIN_PASSWORD="$(openssl rand -base64 12 2>/dev/null || echo "Admin$(date +%s | tail -c 8)")"
    if $HAS_GUM; then
        gum style --foreground 212 --bold "Admin Password (auto-generated if left empty)"
        ADMIN_PASS_INPUT=$(gum input --placeholder "Leave empty for: $ADMIN_PASSWORD")
    else
        ADMIN_PASS_INPUT=$(prompt_input "Admin Password (auto-generated if left empty)" "Leave empty for auto-generated")
    fi
    [ -n "$ADMIN_PASS_INPUT" ] && ADMIN_PASSWORD="$ADMIN_PASS_INPUT"

    ALLOWED_PHONES_VAL=""
    if [ "$ACCESS_MODE" != "Email (dashboard only)" ]; then
        if $HAS_GUM; then
            gum style --foreground 212 --bold "Allowed WhatsApp numbers (comma-separated, with country code)"
            ALLOWED_PHONES_VAL=$(gum input --placeholder "91997XXXXXXX,91998XXXXXXX")
        else
            ALLOWED_PHONES_VAL=$(prompt_input "Allowed WhatsApp numbers (comma-separated, with country code)" "91997XXXXXXX,91998XXXXXXX")
        fi
    fi

    JWT_DEFAULT="$(openssl rand -hex 32 2>/dev/null || echo "change-me-$(date +%s)")"
    if $HAS_GUM; then
        gum style --foreground 212 --bold "JWT Secret (auto-generated if left empty)"
        JWT_SECRET=$(gum input --placeholder "Leave empty for auto-generated")
    else
        JWT_SECRET=$(prompt_input "JWT Secret (auto-generated if left empty)" "Leave empty for auto-generated")
    fi
    [ -z "$JWT_SECRET" ] && JWT_SECRET="$JWT_DEFAULT"

    SMTP_USER=""; SMTP_PASS=""; SMTP_HOST="smtp.gmail.com"
    if [ "$ACCESS_MODE" != "WhatsApp (QR scan)" ]; then
        if $HAS_GUM; then
            gum style --foreground 212 --bold "SMTP Email"
            SMTP_USER=$(gum input --placeholder "you@gmail.com")
            gum style --foreground 212 --bold "SMTP App Password"
            SMTP_PASS=$(gum input --password --placeholder "your-app-password")
            gum style --foreground 212 --bold "SMTP Host [smtp.gmail.com]"
            SMTP_HOST_INPUT=$(gum input --placeholder "smtp.gmail.com")
        else
            SMTP_USER=$(prompt_input "SMTP Email" "you@gmail.com")
            SMTP_PASS=$(prompt_input "SMTP App Password" "your-app-password" true)
            SMTP_HOST_INPUT=$(prompt_input "SMTP Host" "smtp.gmail.com")
        fi
        [ -n "$SMTP_HOST_INPUT" ] && SMTP_HOST="$SMTP_HOST_INPUT"
    fi

    CLAUDE_BIN_PATH=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
    if $HAS_GUM; then
        gum style --foreground 212 --bold "Default Claude working directory [/home/ubuntu]"
        WORKING_DIR=$(gum input --placeholder "/home/ubuntu")
        gum style --foreground 212 --bold "Claude binary path [$CLAUDE_BIN_PATH]"
        CLAUDE_BIN_INPUT=$(gum input --placeholder "$CLAUDE_BIN_PATH")
    else
        WORKING_DIR=$(prompt_input "Default Claude working directory" "/home/ubuntu")
        CLAUDE_BIN_INPUT=$(prompt_input "Claude binary path" "$CLAUDE_BIN_PATH")
    fi
    [ -z "$WORKING_DIR" ] && WORKING_DIR="/home/ubuntu"
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
ADMIN_PASSWORD=$ADMIN_PASSWORD

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
        if $HAS_GUM; then
            gum confirm "Create Supabase tables now?" && (node supabase_setup.js || warn "Auto-setup had issues — check Supabase SQL Editor")
        elif prompt_confirm "Create Supabase tables now?"; then
            node supabase_setup.js || warn "Auto-setup had issues — check Supabase SQL Editor"
        fi
    fi
}

start_service() {
    step 6 "Start the Service"
    local should_start=false
    if $HAS_GUM; then
        gum confirm "Start WhatsApp AI Engineer now?" && should_start=true
    else
        prompt_confirm "Start WhatsApp AI Engineer now?" && should_start=true
    fi

    if $should_start; then
        bash ./start.sh
        ok "Started! Run: tail -f /tmp/wa-engineer.log"
        echo ""
        echo -e "${GREEN}${BOLD}Setup complete!${NC}"
        echo -e "  Dashboard: ${BLUE}http://localhost:18790${NC}"
        echo ""
        echo -e "${YELLOW}${BOLD}  Admin Login Credentials:${NC}"
        echo -e "    Email:    ${GREEN}${ADMIN_EMAIL}${NC}"
        echo -e "    Password: ${GREEN}${ADMIN_PASSWORD}${NC}"
        echo -e "    ${YELLOW}(Save these! Change after first login)${NC}"
        echo ""
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
build_frontend
check_claude
choose_mode
configure_env
start_service
