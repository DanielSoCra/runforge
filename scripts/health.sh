#!/bin/bash
echo "=== Auto-Claude Health Check ==="
echo ""
for role in reviewer developer pipeline; do
  HB=~/logs/claude-$role.heartbeat
  if [ ! -f "$HB" ]; then
    echo "$role: NEVER RAN"
  else
    LAST=$(cat "$HB")
    AGE=$(( $(date +%s) - $(date -j -f '%Y-%m-%d %H:%M:%S' "$LAST" +%s 2>/dev/null || echo 0) ))
    if [ $AGE -gt 3600 ]; then
      echo "$role: STALE ($AGE seconds since last heartbeat)"
    else
      echo "$role: OK (last: $LAST)"
    fi
  fi
done
echo ""
echo "=== Open Issues ==="
gh issue list --label "review-finding" --state open --json number,title,labels --template '{{range .}}#{{.number}} [{{range .labels}}{{.name}} {{end}}] {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Blocked ==="
gh issue list --label "blocked" --state open --json number,title --template '{{range .}}#{{.number}} {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Pipeline Status ==="
gh issue list --label "feature-pipeline" --state open --repo DANIELSOCRAHANDLEZZ/auto-claude --json number,title,labels --template '{{range .}}#{{.number}} [{{range .labels}}{{.name}} {{end}}] {{.title}}{{"\n"}}{{end}}'
echo ""
echo "=== Stale Pipeline Issues (>1hr) ==="
for label in l3-in-progress l3-review implementing; do
  STALE=$(gh issue list --repo DANIELSOCRAHANDLEZZ/auto-claude \
    --label "feature-pipeline,$label" \
    --state open --json number,title,updatedAt \
    --jq "[.[] | select((.updatedAt | fromdateiso8601) < (now - 3600))]" 2>/dev/null)
  COUNT=$(echo "$STALE" | jq 'length' 2>/dev/null)
  if [ "$COUNT" -gt 0 ]; then
    echo "WARNING: $COUNT stale issue(s) with label '$label' (>1hr without update):"
    echo "$STALE" | jq -r '.[] | "  #\(.number): \(.title)"'
  fi
done
