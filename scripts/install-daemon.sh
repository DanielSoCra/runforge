#!/bin/bash
# install-daemon.sh — Install the unified daemon launchd plist and retire legacy shell scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/com.autoclaude.daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.autoclaude.daemon.plist"
ENV_FILE="$REPO_ROOT/.env.mac"
LOG_DIR="$HOME/logs"
NPX_PATH="$(which npx)"
CURRENT_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 1. Unload old plists
log "Unloading legacy plists..."
for label in com.autoclaude.pipeline com.autoclaude.developer com.autoclaude.reviewer; do
  old_plist="$HOME/Library/LaunchAgents/${label}.plist"
  if launchctl list "$label" &>/dev/null; then
    launchctl unload "$old_plist" 2>/dev/null && log "  Unloaded $label" || log "  WARN: Could not unload $label"
  else
    log "  $label not loaded, skipping"
  fi
done

# 2. Ensure log directory exists
mkdir -p "$LOG_DIR"

# 3. Substitute env vars from .env.mac into plist
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Create it from .env.mac.example first." >&2
  exit 1
fi

log "Reading environment from $ENV_FILE..."
# Source the env file to get variable values
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

log "Installing daemon plist..."
log "  npx: $NPX_PATH"
log "  repo: $REPO_ROOT"
sed \
  -e "s|__NPX_PATH__|${NPX_PATH}|g" \
  -e "s|__REPO_ROOT__|${REPO_ROOT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__PATH__|${CURRENT_PATH}|g" \
  -e "s|__GITHUB_TOKEN__|${GITHUB_TOKEN}|g" \
  -e "s|__SUPABASE_URL__|${SUPABASE_URL}|g" \
  -e "s|__SUPABASE_SERVICE_ROLE_KEY__|${SUPABASE_SERVICE_ROLE_KEY}|g" \
  -e "s|__NEXT_PUBLIC_SUPABASE_URL__|${NEXT_PUBLIC_SUPABASE_URL}|g" \
  -e "s|__NEXT_PUBLIC_SUPABASE_ANON_KEY__|${NEXT_PUBLIC_SUPABASE_ANON_KEY}|g" \
  -e "s|__ENCRYPTION_KEY__|${ENCRYPTION_KEY}|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# 4. Load and start
log "Loading daemon plist..."
launchctl load "$PLIST_DST"

log "Done. Verify with: launchctl list | grep autoclaude"
log "Logs: tail -f $LOG_DIR/claude-daemon.log"
log "Health: $REPO_ROOT/scripts/health.sh"
