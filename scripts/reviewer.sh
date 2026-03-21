#!/bin/bash
cd ~/code/auto-claude
FAIL_COUNT=0
MAX_BACKOFF=3600

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [reviewer] $*"; }

rotate_log() {
  local logfile=$1
  if [ -f "$logfile" ] && [ $(stat -f%z "$logfile" 2>/dev/null || echo 0) -gt 10485760 ]; then
    mv "$logfile" "$logfile.$(date +%Y%m%d%H%M%S)"
    gzip "$logfile".* 2>/dev/null &
  fi
}

while true; do
  rotate_log ~/logs/claude-reviewer.log
  log "Starting review cycle"

  if ! git checkout dev 2>&1 || ! git pull --ff-only 2>&1; then
    log "WARN: git pull failed, attempting merge pull"
    git pull --no-rebase 2>&1 || { log "ERROR: git pull failed"; sleep 300; continue; }
  fi

  if clyo -p --max-budget-usd 5 "Use the verified-codebase-review skill. Review this repo. Use gh CLI to check existing review-finding issues and determine which category area is stalest. Two-phase discovery+verification. HIGH confidence findings: create GitHub issue with review-finding + priority + category labels. MEDIUM: create with unverified label. Discard LOW. Also spot-check open issues and close any that have been fixed on dev."; then
    FAIL_COUNT=0
    date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-reviewer.heartbeat
    log "Review cycle complete"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    BACKOFF=$(( 60 * (2 ** (FAIL_COUNT - 1)) ))
    [ $BACKOFF -gt $MAX_BACKOFF ] && BACKOFF=$MAX_BACKOFF
    log "ERROR: clyo failed (attempt $FAIL_COUNT), backing off ${BACKOFF}s"
    sleep $BACKOFF
    continue
  fi

  sleep 1200
done
