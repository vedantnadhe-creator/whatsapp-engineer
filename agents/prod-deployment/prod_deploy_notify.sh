#!/bin/bash
# ============================================================================
# prod_deploy_notify.sh — parallel PROD deploy orchestrator + Slack notifier
# ============================================================================
# Deploys N services to PROD in PARALLEL by calling the box's own deploy script
# once per service, and posts a live status roll-up to Slack (#infrahub) on
# start, every REPORT_INTERVAL seconds, and on completion.
#
# WHERE THIS RUNS: on the PROD builder box (140.245.25.134 / pl-prod-builder-v2)
# where ~/autodeploy.sh, docker, kubectl and the repo checkouts live. The Prod
# Deployment agent scp's this file up and runs it there — it does NOT run on the
# dashboard box.
#
# Usage:
#   INFRAHUB_SLACK_TOKEN=xoxb-... ./prod_deploy_notify.sh <branch> <svc1> [svc2 ...]
#
# Example:
#   INFRAHUB_SLACK_TOKEN=xoxb-... ./prod_deploy_notify.sh release-v1.36 admin-node student-node admin-react
#
# PARALLEL SAFETY: plain autodeploy.sh runs `docker system prune -af` at the
# start of every build — fatal when 5 builds race (they delete each other's
# in-progress layers). So this orchestrator does ONE prune up front, then uses
# autodeploy_noprune.sh (the prune-free variant already on the box) per service.
# Override with DEPLOY_SCRIPT=... if you must.
# ============================================================================

set -uo pipefail

# ---- config ----------------------------------------------------------------
SLACK_CHANNEL="${SLACK_CHANNEL:-C0BF1GTHZ6G}"          # #infrahub
SLACK_TOKEN="${INFRAHUB_SLACK_TOKEN:-}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-$HOME/autodeploy_noprune.sh}"
PRUNE_SCRIPT="${PRUNE_SCRIPT:-$HOME/autodeploy.sh}"     # only used to detect; prune done inline
REPORT_INTERVAL="${REPORT_INTERVAL:-180}"              # 3 minutes
POLL_INTERVAL="${POLL_INTERVAL:-10}"
DO_PRUNE="${DO_PRUNE:-1}"                              # one prune before the parallel builds

# ---- args ------------------------------------------------------------------
BRANCH="${1:-}"; shift || true
SERVICES=("$@")
if [[ -z "$BRANCH" || ${#SERVICES[@]} -eq 0 ]]; then
  echo "usage: INFRAHUB_SLACK_TOKEN=xoxb-... $0 <branch> <svc1> [svc2 ...]" >&2
  exit 2
fi
if [[ ! -x "$DEPLOY_SCRIPT" ]]; then
  echo "ERROR: deploy script not found/executable: $DEPLOY_SCRIPT" >&2
  echo "       (expected the prune-free variant on the prod box)" >&2
  exit 2
fi

RUN_ID="$(date +%s)"
STATEDIR="/tmp/prod_deploy_${RUN_ID}"
mkdir -p "$STATEDIR"
START_EPOCH=$SECONDS
SLACK_TS=""   # message ts for update-in-place (if chat.update is permitted)

# ---- slack -----------------------------------------------------------------
# Posts (or updates) a single roll-up message. chat:write is enough to post;
# if the token also has chat:write for updates we edit in place, else we post
# fresh each interval. Failures here never abort the deploy.
slack_post() {
  local text="$1"
  [[ -z "$SLACK_TOKEN" ]] && { echo "[slack disabled: no token]"; return 0; }
  local resp
  if [[ -n "$SLACK_TS" ]]; then
    resp=$(curl -s -X POST https://slack.com/api/chat.update \
      -H "Authorization: Bearer ${SLACK_TOKEN}" \
      -H 'Content-type: application/json; charset=utf-8' \
      --data "$(json_payload "$text" "$SLACK_TS")" 2>/dev/null)
    # if update failed (e.g. no scope), fall through to a fresh post
    echo "$resp" | grep -q '"ok":true' && return 0
    SLACK_TS=""
  fi
  resp=$(curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer ${SLACK_TOKEN}" \
    -H 'Content-type: application/json; charset=utf-8' \
    --data "$(json_payload "$text" "")" 2>/dev/null)
  SLACK_TS=$(echo "$resp" | sed -n 's/.*"ts":"\([0-9.]*\)".*/\1/p' | head -1)
  echo "$resp" | grep -q '"ok":true' || echo "[slack post failed: $resp]"
}

# Build a JSON payload safely (escape the text via a here-string + python if
# available, else a conservative sed). Keeps newlines.
json_payload() {
  local text="$1" ts="$2"
  if command -v python3 >/dev/null 2>&1; then
    CH="$SLACK_CHANNEL" TXT="$text" TS="$ts" python3 - <<'PY'
import json, os
d = {"channel": os.environ["CH"], "text": os.environ["TXT"], "unfurl_links": False, "unfurl_media": False}
if os.environ.get("TS"): d["ts"] = os.environ["TS"]
print(json.dumps(d))
PY
  else
    local esc=${text//\\/\\\\}; esc=${esc//\"/\\\"}; esc=${esc//$'\n'/\\n}
    if [[ -n "$ts" ]]; then
      printf '{"channel":"%s","ts":"%s","text":"%s","unfurl_links":false}' "$SLACK_CHANNEL" "$ts" "$esc"
    else
      printf '{"channel":"%s","text":"%s","unfurl_links":false}' "$SLACK_CHANNEL" "$esc"
    fi
  fi
}

fmt_elapsed() {
  local s=$(( SECONDS - START_EPOCH )); printf '%dm%02ds' $(( s/60 )) $(( s%60 ))
}

# Build the status roll-up text from per-service state files.
status_text() {
  local header="$1" done_c=0 fail_c=0 run_c=0 lines=""
  for svc in "${SERVICES[@]}"; do
    local rc_file="$STATEDIR/$svc.rc" icon status extra=""
    if [[ -f "$rc_file" ]]; then
      local rc; rc=$(cat "$rc_file")
      if [[ "$rc" == "0" ]]; then icon="✅"; status="done"; ((done_c++))
      else icon="❌"; status="FAILED (exit $rc)"; ((fail_c++))
        extra=" — $(tail -n 2 "$STATEDIR/$svc.log" 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
      fi
    else icon="⏳"; status="building…"; ((run_c++))
      extra=" — $(tail -n 1 "$STATEDIR/$svc.log" 2>/dev/null | cut -c1-100)"
    fi
    lines+=$'\n'"  $icon  \`$svc\`  $status$extra"
  done
  printf '%s  •  branch \`%s\`  •  %s elapsed\n%d done / %d failed / %d in-progress%s' \
    "$header" "$BRANCH" "$(fmt_elapsed)" "$done_c" "$fail_c" "$run_c" "$lines"
}

# ---- one-time prune (safe: before any parallel build starts) ---------------
if [[ "$DO_PRUNE" == "1" ]]; then
  echo ">> One-time docker prune before parallel builds…"
  docker system prune -af >/dev/null 2>&1 || echo "[prune warning — continuing]"
fi

# ---- launch all services in parallel ---------------------------------------
declare -A PIDS
for svc in "${SERVICES[@]}"; do
  ( "$DEPLOY_SCRIPT" "$svc" "$BRANCH" > "$STATEDIR/$svc.log" 2>&1; echo $? > "$STATEDIR/$svc.rc" ) &
  PIDS[$svc]=$!
  echo ">> launched $svc (pid ${PIDS[$svc]}) → $STATEDIR/$svc.log"
done

slack_post ":rocket: *PROD deploy started* $(status_text 'Deploying')"

# ---- monitor loop ----------------------------------------------------------
last_report=$SECONDS
while :; do
  # any still running?
  running=0
  for svc in "${SERVICES[@]}"; do [[ -f "$STATEDIR/$svc.rc" ]] || running=1; done
  now=$SECONDS
  if (( now - last_report >= REPORT_INTERVAL )); then
    slack_post ":hourglass_flowing_sand: *PROD deploy in progress* $(status_text 'Progress')"
    last_report=$now
  fi
  [[ $running -eq 0 ]] && break
  sleep "$POLL_INTERVAL"
done

# ---- final roll-up ---------------------------------------------------------
fails=0
for svc in "${SERVICES[@]}"; do
  rc=$(cat "$STATEDIR/$svc.rc" 2>/dev/null || echo 1)
  [[ "$rc" == "0" ]] || ((fails++))
done
if [[ $fails -eq 0 ]]; then
  slack_post ":white_check_mark: *PROD deploy COMPLETE* $(status_text 'All services deployed')"
else
  slack_post ":rotating_light: *PROD deploy finished with ${fails} FAILURE(s)* $(status_text 'Review failed services')"
fi

echo ">> logs in $STATEDIR"
exit $(( fails > 0 ? 1 : 0 ))
