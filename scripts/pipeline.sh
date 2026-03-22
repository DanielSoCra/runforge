#!/bin/bash
cd ~/code/auto-claude
REPO="DANIELSOCRAHANDLEZZ/auto-claude"
FAIL_COUNT=0
MAX_BACKOFF=3600

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [pipeline] $*"; }

rotate_log() {
  local logfile="$1"
  if [ -f "$logfile" ] && [ $(stat -f%z "$logfile" 2>/dev/null || echo 0) -gt 10485760 ]; then
    mv "$logfile" "$logfile.$(date +%Y%m%d%H%M%S)"
    gzip "$logfile".* 2>/dev/null &
  fi
}

check_stage() {
  local target="$1"; shift
  local result
  result=$(gh issue list --repo "$REPO" \
    --label "feature-pipeline,$target" \
    --state open --json number,title,labels 2>/dev/null)

  for exclude in "$@"; do
    result=$(echo "$result" | jq \
      "[.[] | select(.labels | map(.name) | contains([\"$exclude\"]) | not)]" 2>/dev/null)
  done
  echo "$result"
}

find_work() {
  local eligible

  # Priority 1: Implementation work (finish what's started)
  eligible=$(check_stage "ready-to-implement" "implementing" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-implement"
    return 0
  fi

  # Priority 2: L3 generation from approved L2
  eligible=$(check_stage "l2-approved" "l3-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-generate-l3"
    return 0
  fi

  # Priority 3: L2 feedback re-run (Operator sent back from l2-review)
  eligible=$(check_stage "l2-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-brainstorm-l2"
    return 0
  fi

  # Priority 4: L2 brainstorming from approved L1 (new work)
  eligible=$(check_stage "l1-approved" "l2-in-progress" "blocked")
  if [ "$(echo "$eligible" | jq 'length' 2>/dev/null)" -gt 0 ]; then
    ISSUE_NUM=$(echo "$eligible" | jq -r '.[0].number')
    SKILL="spec-brainstorm-l2"
    return 0
  fi

  return 1
}

while true; do
  rotate_log ~/logs/claude-pipeline.log

  # Reset to clean state (handles dirty working tree from crashed sessions)
  git checkout dev -f -q 2>/dev/null
  git clean -fd -q 2>/dev/null

  if ! git pull --ff-only -q 2>/dev/null; then
    log "WARN: git pull failed, attempting merge pull"
    GIT_MERGE_AUTOEDIT=no git pull --no-rebase --no-edit -q 2>/dev/null || {
      log "ERROR: git pull failed"
      sleep 300
      continue
    }
  fi

  if find_work; then
    log "Found work: issue #$ISSUE_NUM → skill $SKILL"
    claude --dangerously-skip-permissions -p --max-budget-usd 10 \
      "Use the $SKILL skill to work on issue #$ISSUE_NUM in repo $REPO. Read the issue body for context and spec references."
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      FAIL_COUNT=0
      date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-pipeline.heartbeat
      log "Pipeline cycle complete for issue #$ISSUE_NUM"
      # Skills push their own branches; safety-net push dev only
      git push origin dev -q 2>/dev/null
      sleep 10
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      BACKOFF=$(( 60 * (2 ** (FAIL_COUNT - 1)) ))
      [ $BACKOFF -gt $MAX_BACKOFF ] && BACKOFF=$MAX_BACKOFF
      log "ERROR: claude failed on issue #$ISSUE_NUM (attempt $FAIL_COUNT), backing off ${BACKOFF}s"
      sleep $BACKOFF
    fi
  else
    date '+%Y-%m-%d %H:%M:%S' > ~/logs/claude-pipeline.heartbeat
    log "No eligible pipeline work found, sleeping 10 minutes"
    sleep 600
  fi
done
