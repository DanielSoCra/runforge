#!/usr/bin/env bash
#
# install-creds-sync.sh — install + load the launchd job that keeps a
# containerized daemon's subscription token fresh from the host Keychain.
#
# The container mounts CREDS_DIR at /root/.claude (read-only auth); this job
# runs sync-claude-creds.sh every 15 min so the access-token is always fresh
# WITHOUT the container running its own (refresh-token-rotating) refresh cycle.
#
# Usage:
#   install-creds-sync.sh <CREDS_DIR>
#   AUTO_CLAUDE_CREDS_DIR=/private/tmp/pilot-claude install-creds-sync.sh
#
# CREDS_DIR is the host dir bind-mounted to /root/.claude in the daemon
# container (for the pilot: /private/tmp/pilot-claude).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/com.autoclaude.creds-sync.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.autoclaude.creds-sync.plist"
LABEL="com.autoclaude.creds-sync"
CREDS_DIR="${1:-${AUTO_CLAUDE_CREDS_DIR:-}}"
# PATH the launchd job runs with: must reach security, python3, mktemp, id, date.
JOB_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

if [ -z "$CREDS_DIR" ]; then
  echo "ERROR: CREDS_DIR required (arg 1 or AUTO_CLAUDE_CREDS_DIR)." >&2
  echo "  e.g. $0 /private/tmp/pilot-claude" >&2
  exit 2
fi
[ -f "$PLIST_SRC" ] || { echo "ERROR: plist template not found: $PLIST_SRC" >&2; exit 1; }

# 1. Seed + validate the token ONCE before loading — fail loudly if the host
#    Keychain has no valid 'claude' login (the job would otherwise sync nothing).
log "Seeding token from Keychain into $CREDS_DIR ..."
if ! "$REPO_ROOT/scripts/sync-claude-creds.sh" "$CREDS_DIR"; then
  echo "ERROR: initial sync failed — is the host 'claude' CLI logged in?" >&2
  echo "  Re-auth on the host (claude /login), then re-run this installer." >&2
  exit 1
fi

# 2. Substitute placeholders into the plist.
mkdir -p "$HOME/logs" "$(dirname "$PLIST_DST")"
sed -e "s#__REPO_ROOT__#${REPO_ROOT}#g" \
    -e "s#__CREDS_DIR__#${CREDS_DIR}#g" \
    -e "s#__HOME__#${HOME}#g" \
    -e "s#__PATH__#${JOB_PATH}#g" \
    "$PLIST_SRC" > "$PLIST_DST"
log "Wrote $PLIST_DST"

# 3. Reload (unload-if-present, then load -w to enable across logins).
if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  log "Unloaded existing $LABEL"
fi
launchctl load -w "$PLIST_DST"
log "Loaded $LABEL"

# 4. Verify it registered.
if launchctl list "$LABEL" >/dev/null 2>&1; then
  log "OK — $LABEL is loaded (refreshes $CREDS_DIR/.credentials.json every 15 min)."
  log "    Log: $HOME/logs/claude-creds-sync.log"
else
  echo "ERROR: $LABEL did not register with launchd." >&2
  exit 1
fi
