#!/bin/bash
cd ~/code/auto-claude
FAIL_COUNT=0
MAX_BACKOFF=3600

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [developer] $*"; }

rotate_log() {
  local logfile=$1
  if [ -f "$logfile" ] && [ $(stat -f%z "$logfile" 2>/dev/null || echo 0) -gt 10485760 ]; then
    mv "$logfile" "$logfile.$(date +%Y%m%d%H%M%S)"
    gzip "$logfile".* 2>/dev/null &
  fi
}

while true; do
  rotate_log ~/logs/claude-developer.log
  log "Checking for work"

  if ! git checkout dev 2>&1 || ! git pull --ff-only 2>&1; then
    log "WARN: git pull failed, attempting merge pull"
    git pull --no-rebase 2>&1 || { log "ERROR: git pull failed"; sleep 300; continue; }
  fi

  claude --dangerously-skip-permissions -p --max-budget-usd 10 "Use the fix-review-issues skill. Use gh CLI to find the highest priority open issue labeled review-finding that does not have in-progress or blocked labels (check P0 first, then P1, P2, P3). If none found, exit 0. Add in-progress label. Fix it: read the spec chain first (traceability.yml → L3 → L2 → L1), implement on a fix/ branch from dev, write a regression test, run pnpm -r run test and typecheck, use the requesting-code-review superpower to review changes, rebase onto dev and merge. Close the issue with gh issue close and note the commit SHA. If blocked after 3 attempts, add blocked label and move on."
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    FAIL_COUNT=0
    date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-developer.heartbeat
    log "Fix cycle complete (or backlog empty), checking again shortly"
    sleep 10
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    BACKOFF=$(( 60 * (2 ** (FAIL_COUNT - 1)) ))
    [ $BACKOFF -gt $MAX_BACKOFF ] && BACKOFF=$MAX_BACKOFF
    log "ERROR: claude --dangerously-skip-permissions failed (exit $EXIT_CODE, attempt $FAIL_COUNT), backing off ${BACKOFF}s"
    sleep $BACKOFF
  fi
done
