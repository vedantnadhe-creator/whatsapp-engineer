#!/bin/bash
# start.sh — Start WhatsApp AI Engineer in background

cd "$(dirname "$0")" || exit 1

echo "Starting WhatsApp AI Engineer..."

# Ensure Node.js 20+ (required by @whiskeysockets/baileys)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || nvm use 20.20.2 >/dev/null 2>&1 || true
fi
echo "Using node: $(command -v node) ($(node --version))"

if [ -f .env ]; then
    export $(grep -v '^#' .env | tr -d '\r' | xargs)
    echo "Loaded environment variables from .env"
else
    echo "No .env file found! Make sure you copied .env.example"
fi

if [ -f package.json ]; then
    echo "Checking dependencies..."
    npm install --silent

    echo "Building native modules (node-pty)..."
    if ! npm rebuild node-pty --silent 2>/dev/null; then
        echo "ERROR: Failed to build node-pty native addon."
        echo "Install build tools: sudo apt-get install -y python3 make g++"
        exit 1
    fi
    echo "Dependencies ready."
fi

if [ -n "$GITHUB_KB_URL" ]; then
    KB_PATH=${KB_DIR:-./kb}
    if [ ! -d "$KB_PATH/.git" ]; then
        echo "Cloning Knowledge Base from $GITHUB_KB_URL to $KB_PATH..."
        git clone "$GITHUB_KB_URL" "$KB_PATH"
    else
        echo "Updating Knowledge Base in $KB_PATH..."
        git -C "$KB_PATH" pull
    fi
else
    echo "No GITHUB_KB_URL configured. Skipping Knowledge Base sync."
fi

# ── Instance isolation ────────────────────────────────────────
# Several checkouts of this repo run side by side (whatsapp-engineer,
# whatsapp-engineer-qweasd, ...). Each is identified by its dashboard PORT, so we
# only stop the process that is listening on THIS instance's port AND running out
# of THIS directory. The old blanket `pkill -f "node index.js"` matched every
# checkout's command line and killed all of them.
INSTANCE=$(basename "$PWD")
PORT=${PORT:-18790}
LOG="/tmp/wa-engineer-${INSTANCE}.log"

echo "Instance: $INSTANCE  (port $PORT)"
echo "Stopping old instance of this checkout..."
for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    owner=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
    if [ "$owner" = "$(readlink -f "$PWD")" ]; then
        kill "$pid" 2>/dev/null && echo "  stopped old PID $pid"
    else
        echo "ERROR: port $PORT is held by PID $pid running from '${owner:-unknown}'."
        echo "       Refusing to kill another instance. Set a free PORT= in $PWD/.env and re-run."
        exit 1
    fi
done
sleep 1

touch "$LOG"
chmod 666 "$LOG"

echo "Starting daemon..."
nohup node index.js > "$LOG" 2>&1 &
echo "Started PID=$!"

sleep 3
echo ""
echo "=== Last 20 log lines ==="
tail -20 "$LOG"
echo "========================="
echo ""
echo "To monitor logs live, run: tail -f $LOG"
