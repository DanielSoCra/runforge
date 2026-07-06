#!/usr/bin/env bash
# External /health monitor for deployment #0 (runbook: "Unattended monitoring
# (REQUIRED for a governed deployment)"). Run every 5 min via launchd.
#
# - Appends every probe to logs/health.log
# - On a state TRANSITION (ok<->degraded<->unhealthy/down) appends to
#   logs/alerts.log and fires a macOS notification.
set -u

OPS=~/code/auto-claude-ops
STATE_FILE="$OPS/logs/.health-state"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
BODY_FILE="$(mktemp)"

mkdir -p "$OPS/logs"

HTTP_CODE="$(curl -sS -m 10 -o "$BODY_FILE" -w '%{http_code}' localhost:3847/health 2>/dev/null)" && CURL_OK=1 || CURL_OK=0
BODY="$(cat "$BODY_FILE" 2>/dev/null || true)"
rm -f "$BODY_FILE"

if [ "$CURL_OK" = "1" ]; then
  if [ "$HTTP_CODE" = "200" ]; then
    DEGRADED="$(printf '%s' "$BODY" | /usr/bin/grep -o '"degraded":[a-z]*' | cut -d: -f2)"
    if [ "$DEGRADED" = "true" ]; then STATE="degraded"; else STATE="ok"; fi
  else
    STATE="unhealthy"
  fi
else
  HTTP_CODE="${HTTP_CODE:-000}"
  STATE="down"
fi

echo "$TS $STATE http=$HTTP_CODE ${BODY:-no-body}" >> "$OPS/logs/health.log"

PREV="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"
if [ "$STATE" != "$PREV" ]; then
  echo "$STATE" > "$STATE_FILE"
  echo "$TS TRANSITION $PREV -> $STATE http=$HTTP_CODE ${BODY:-no-body}" >> "$OPS/logs/alerts.log"
  /usr/bin/osascript -e "display notification \"auto-claude daemon0: $PREV -> $STATE\" with title \"auto-claude health\"" 2>/dev/null || true
fi
