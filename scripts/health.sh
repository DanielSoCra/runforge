#!/bin/bash
echo "=== Auto-Claude Health Check ==="
echo ""
for role in reviewer developer; do
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
