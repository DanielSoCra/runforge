#!/bin/bash
# DEPRECATED: Migrated to daemon control plane. See docs/running.md
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

  # Count existing issues before this cycle
  BEFORE_COUNT=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude --label "review-finding" --state open --json number --jq 'length' 2>/dev/null || echo 0)

  if claude --dangerously-skip-permissions -p --max-budget-usd 5 "Use the verified-codebase-review skill. Review this repo. Use gh CLI to check existing review-finding issues and determine which category area is stalest. Two-phase discovery+verification with judge filter. HIGH confidence findings: create GitHub issue with review-finding + priority + category labels. MEDIUM: create with unverified label. Discard LOW. IMPORTANT: Maximum 5 new issues per cycle. If you have more than 5 findings after the judge phase, keep only the top 5 by severity. Also spot-check open issues and close any that have been fixed on dev."; then

    # Count issues after cycle
    AFTER_COUNT=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude --label "review-finding" --state open --json number --jq 'length' 2>/dev/null || echo 0)
    NEW_ISSUES=$((AFTER_COUNT - BEFORE_COUNT))

    # Signal ratio (guard against division by zero)
    VERIFIED=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude --label "review-finding,verified" --state closed --json number --jq 'length' 2>/dev/null || echo 0)
    TOTAL_CLOSED=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude --label "review-finding" --state closed --json number --jq 'length' 2>/dev/null || echo 0)
    [ "$TOTAL_CLOSED" -eq 0 ] && TOTAL_CLOSED=1
    RATIO=$(( VERIFIED * 100 / TOTAL_CLOSED ))

    FAIL_COUNT=0
    date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-reviewer.heartbeat
    log "Review cycle complete. New issues: $NEW_ISSUES. Signal ratio: $VERIFIED/$TOTAL_CLOSED ($RATIO%)"

    # If signal ratio drops below 60%, increase sleep to reduce noise generation
    if [ "$RATIO" -lt 60 ] 2>/dev/null; then
      log "WARN: Signal ratio below 60% — increasing interval to 1 hour"
      sleep 3600
      continue
    fi
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    BACKOFF=$(( 60 * (2 ** (FAIL_COUNT - 1)) ))
    [ $BACKOFF -gt $MAX_BACKOFF ] && BACKOFF=$MAX_BACKOFF
    log "ERROR: claude --dangerously-skip-permissions failed (attempt $FAIL_COUNT), backing off ${BACKOFF}s"
    sleep $BACKOFF
    continue
  fi

  sleep 1200
done
