#!/bin/bash
echo "=== Runforge Health Check ==="
echo ""

# Check daemon heartbeat (unified process replaces legacy per-role heartbeats)
HB=~/logs/claude-daemon.heartbeat
if [ ! -f "$HB" ]; then
  echo "daemon: NEVER RAN"

  # Fall back to legacy heartbeats if daemon heartbeat doesn't exist
  echo ""
  echo "=== Legacy Heartbeats (deprecated) ==="
  for role in reviewer developer pipeline; do
    LEGACY_HB=~/logs/claude-$role.heartbeat
    if [ ! -f "$LEGACY_HB" ]; then
      echo "$role: NEVER RAN"
    else
      LAST=$(cat "$LEGACY_HB")
      AGE=$(( $(date +%s) - $(date -j -f '%Y-%m-%d %H:%M:%S' "$LAST" +%s 2>/dev/null || echo 0) ))
      if [ $AGE -gt 3600 ]; then
        echo "$role: STALE ($AGE seconds since last heartbeat)"
      else
        echo "$role: OK (last: $LAST)"
      fi
    fi
  done
else
  LAST=$(cat "$HB")
  AGE=$(( $(date +%s) - $(date -j -f '%Y-%m-%d %H:%M:%S' "$LAST" +%s 2>/dev/null || echo 0) ))
  if [ $AGE -gt 120 ]; then
    echo "daemon: STALE ($AGE seconds since last heartbeat)"
  else
    echo "daemon: OK (last: $LAST)"
  fi

  # Also check the control API
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3847/health 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "control API: OK (port 3847)"
  else
    echo "control API: UNREACHABLE (HTTP $STATUS)"
  fi
fi

echo ""
echo "=== Open Issues ==="
gh issue list --label "review-finding" --state open --json number,title,labels --template '{{range .}}#{{.number}} [{{range .labels}}{{.name}} {{end}}] {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Blocked ==="
gh issue list --label "blocked" --state open --json number,title --template '{{range .}}#{{.number}} {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Pipeline Status ==="
gh issue list --label "feature-pipeline" --state open --repo DANIELSOCRAHANDLEZZ/runforge --json number,title,labels --template '{{range .}}#{{.number}} [{{range .labels}}{{.name}} {{end}}] {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Stale Pipeline Issues (>1hr) ==="
for label in l3-in-progress l3-review implementing; do
  STALE=$(gh issue list --repo DANIELSOCRAHANDLEZZ/runforge \
    --label "feature-pipeline,$label" \
    --state open --json number,title,updatedAt \
    --jq "[.[] | select((.updatedAt | fromdateiso8601) < (now - 3600))]" 2>/dev/null)
  COUNT=$(echo "$STALE" | jq 'length' 2>/dev/null)
  if [ "$COUNT" -gt 0 ]; then
    echo "WARNING: $COUNT stale issue(s) with label '$label' (>1hr without update):"
    echo "$STALE" | jq -r '.[] | "  #\(.number): \(.title)"'
  fi
done
