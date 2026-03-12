#!/bin/bash
# start.sh — Start WhatsApp AI Engineer in background

cd "$(dirname "$0")" || exit 1

echo "Starting WhatsApp AI Engineer..."

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

echo "Stopping old instances..."
pkill -f "node index.js" 2>/dev/null || true
sleep 1

touch /tmp/wa-engineer.log
chmod 666 /tmp/wa-engineer.log

echo "Starting daemon..."
nohup node index.js > /tmp/wa-engineer.log 2>&1 &
echo "Started PID=$!"

sleep 3
echo ""
echo "=== Last 20 log lines ==="
tail -20 /tmp/wa-engineer.log
echo "========================="
echo ""
echo "To monitor logs live, run: tail -f /tmp/wa-engineer.log"
