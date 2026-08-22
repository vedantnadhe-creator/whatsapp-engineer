#!/bin/bash
# One-shot delayed restart of THIS checkout's dashboard so the Evolution
# bot-number change takes effect. Delayed because the restart kills the agent
# session that scheduled it, and that session's reply must be delivered first.
# Mirrors start.sh's env loading but skips `npm install`/`npm rebuild node-pty`:
# dependencies are unchanged, and a rebuild failure there would exit before the
# daemon starts, taking OliBot down with no one around to bring it back.
set -u
cd /home/ubuntu/whatsapp-engineer || exit 1

DELAY=${1:-180}
PORT=18790
LOG=/tmp/wa-engineer-whatsapp-engineer.log
OUT=/tmp/olibot-evolution-restart.log
NODE=/home/ubuntu/.nvm/versions/node/v20.20.2/bin/node

exec >>"$OUT" 2>&1
echo "=== $(date -Is) restarting after ${DELAY}s ==="
sleep "$DELAY"

for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "/home/ubuntu/whatsapp-engineer" ]; then
        echo "stopping PID $pid"
        kill "$pid"
    else
        echo "ABORT: port $PORT held by PID $pid from another checkout"
        exit 1
    fi
done
sleep 3

set -a
# shellcheck disable=SC2046,SC2086
export $(grep -v '^#' .env | tr -d '\r' | xargs)
set +a
setsid nohup "$NODE" index.js >>"$LOG" 2>&1 &
echo "started PID $!"

sleep 12
NEW=$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
echo "--- probes ---"
if [ -z "$NEW" ]; then
    echo "VERDICT: DOWN — nothing is listening on $PORT"
    tail -30 "$LOG"
    echo "=== done $(date -Is) ==="
    exit 1
fi
curl -s -o /dev/null -w 'dashboard        %{http_code}  (200 = serving)\n' "http://127.0.0.1:$PORT/"
printf 'oli tools        '; curl -s -o /dev/null -w '%{http_code}  (401 = route exists, auth required)\n' "http://127.0.0.1:$PORT/api/oli/whoami"
printf 'evolution hook   '; curl -s "http://127.0.0.1:$PORT/api/evolution/webhook"; echo
# Config only counts if the RUNNING process has it — a .env edit that never got
# exported looks identical from the outside until a message silently goes missing.
echo "--- live config (from the running process) ---"
tr '\0' '\n' < "/proc/$NEW/environ" \
  | grep -E '^(SPRINT_AGENT_GROUPS|SPRINT_AGENT_OPEN_DMS|ALLOWED_GROUPS|BOT_ALIASES|EVOLUTION_BOT_NUMBER)=' | sort | sed 's/^/  /'
echo "--- whatsapp link ---"
curl -s -H "apikey: $EVOLUTION_API_KEY" \
  "$EVOLUTION_API_URL/instance/connectionState/$EVOLUTION_INSTANCE" | sed 's/^/  /'
echo
echo "--- dashboard log tail ---"
grep -a '\[Evolution\]\|\[SprintSession\]\|Error\|error:' "$LOG" | tail -6
echo "VERDICT: UP (pid $NEW)"
echo "=== done $(date -Is) ==="
