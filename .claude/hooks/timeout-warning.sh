#!/usr/bin/env bash
# timeout-warning.sh — Claude Code PreToolUse hook for session timeout warnings.
# Checks SESSION_START_TIME and SESSION_TIMEOUT_MS env vars. Warns once
# when the session is within 2 minutes of its timeout.
# KEEP IN SYNC with packages/daemon/src/session-runtime/timeout-hook.ts (TIMEOUT_WARNING_MESSAGE).

set -euo pipefail

START_TIME="${SESSION_START_TIME:-0}"
TIMEOUT_MS="${SESSION_TIMEOUT_MS:-600000}"
WARNING_BUFFER_MS=120000

if [ "$START_TIME" -eq 0 ]; then
  exit 0
fi

NOW_MS=$(($(date +%s) * 1000))
ELAPSED=$((NOW_MS - START_TIME))
THRESHOLD=$((TIMEOUT_MS - WARNING_BUFFER_MS))

if [ "$ELAPSED" -le "$THRESHOLD" ]; then
  exit 0
fi

MARKER="/tmp/timeout-warned-${START_TIME}.marker"
if [ -f "$MARKER" ]; then
  exit 0
fi

touch "$MARKER"
cat >&2 <<'WARN'
Warning: Session approaching timeout. Save your progress by writing a handoff note between [HANDOFF] and [/HANDOFF] delimiters. Include: what you completed, what failed, and what to try next. Example:
[HANDOFF]
Completed: implemented X in file Y
Failed: approach Z due to constraint W
Next: try alternative approach A
[/HANDOFF]
WARN
exit 2
