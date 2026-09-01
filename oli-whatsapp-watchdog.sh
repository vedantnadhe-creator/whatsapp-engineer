#!/bin/bash
# Detect and repair a WhatsApp socket that has died while still reporting itself healthy.
#
# Evolution's `connectionState` is not a liveness check. On 2026-08-27 the socket stopped
# receiving and the field went on saying "open" for five days: no messages reached Oli, no
# errors were logged, and the only visible symptom was people in a group wondering why the
# bot had gone quiet. So probe the socket with a query that has to reach WhatsApp, and
# treat "Connection Closed" as dead no matter what the status field claims.
set -u
cd /home/ubuntu/whatsapp-engineer || exit 1

LOG=/tmp/oli-whatsapp-watchdog.log
exec >>"$LOG" 2>&1

set -a
# shellcheck disable=SC2046
eval "$(tr -d '\r' < .env | grep -E '^EVOLUTION_(API_URL|API_KEY|INSTANCE)=')"
set +a
[ -n "${EVOLUTION_API_URL:-}" ] || { echo "$(date -Is) no EVOLUTION_API_URL — skipping"; exit 1; }

say() { echo "$(date -Is) $*"; }

# A real round trip to WhatsApp. Cheap, and unlike fetching groups it cannot be served
# from Evolution's own database, so a wedged socket cannot fake a pass.
probe() {
    local out
    out=$(timeout 30 curl -s -X POST "$EVOLUTION_API_URL/chat/whatsappNumbers/$EVOLUTION_INSTANCE" \
        -H "apikey: $EVOLUTION_API_KEY" -H 'Content-Type: application/json' \
        -d '{"numbers":["919225395447"]}' 2>/dev/null)
    [[ "$out" == \[* ]]
}

probe && exit 0   # healthy: the overwhelmingly common case, so do nothing and stay quiet

say "socket probe FAILED (state says: $(curl -s -H "apikey: $EVOLUTION_API_KEY" \
    "$EVOLUTION_API_URL/instance/connectionState/$EVOLUTION_INSTANCE" 2>/dev/null))"

say "restarting instance $EVOLUTION_INSTANCE"
curl -s -X POST "$EVOLUTION_API_URL/instance/restart/$EVOLUTION_INSTANCE" -H "apikey: $EVOLUTION_API_KEY" >/dev/null
sleep 20
if probe; then say "RECOVERED after instance restart"; exit 0; fi

# The instance restart did not clear it on 2026-09-01; only a container restart did.
say "instance restart insufficient — restarting evolution_api container"
docker restart evolution_api >/dev/null 2>&1
for _ in $(seq 1 20); do
    sleep 10
    if probe; then say "RECOVERED after container restart"; exit 0; fi
done

say "STILL DEAD after both restarts — needs a human (possible QR re-pair)"
exit 1
