#!/bin/bash
# install-daemon.sh — Install the unified daemon launchd plist and retire legacy shell scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_ROOT/scripts/com.runforge.daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.runforge.daemon.plist"
ENV_FILE="${RUNFORGE_ENV_MAC_PATH:-$REPO_ROOT/.env.mac}"
LOG_DIR="$HOME/logs"
NPX_PATH="$(which npx)"
CURRENT_PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 0. Ensure RUNFORGE_CONTROL_TOKEN is provisioned in the env file (idempotent)
provision_control_token() {
  if [ ! -f "$ENV_FILE" ]; then
    return
  fi

  # shellcheck disable=SC1090
  if source "$ENV_FILE" 2>/dev/null && [ -n "${RUNFORGE_CONTROL_TOKEN:-}" ]; then
    return
  fi

  local token
  token="$(openssl rand -hex 32)"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  printf '\nRUNFORGE_CONTROL_TOKEN=%s\n' "$token" >> "$ENV_FILE"
  log "Generated RUNFORGE_CONTROL_TOKEN in $ENV_FILE"
}

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    echo "ERROR: $name must be set in $ENV_FILE for DAEMON_DATA_BACKEND=$DAEMON_DATA_BACKEND_VALUE." >&2
    exit 1
  fi
}

# 1. Unload old plists
log "Unloading legacy plists..."
for label in com.runforge.pipeline com.runforge.developer com.runforge.reviewer; do
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

provision_control_token

log "Reading environment from $ENV_FILE..."
# Source the env file to get variable values
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DAEMON_DATA_BACKEND_VALUE="${DAEMON_DATA_BACKEND:-postgres}"
RUNFORGE_DATABASE_URL_VALUE="${RUNFORGE_DATABASE_URL:-}"
ENCRYPTION_KEY_VALUE="${ENCRYPTION_KEY:-}"
RUNFORGE_CONTROL_TOKEN_VALUE="${RUNFORGE_CONTROL_TOKEN:-}"

case "$DAEMON_DATA_BACKEND_VALUE" in
  postgres) ;;
  *)
    echo "ERROR: DAEMON_DATA_BACKEND must be postgres." >&2
    exit 1
    ;;
esac

require_env GITHUB_TOKEN
require_env RUNFORGE_DATABASE_URL
require_env ENCRYPTION_KEY
require_env RUNFORGE_CONTROL_TOKEN

log "Installing daemon plist..."
log "  npx: $NPX_PATH"
log "  repo: $REPO_ROOT"
PLIST_TMP=$(mktemp "${PLIST_DST}.XXXXXX")
chmod 600 "$PLIST_TMP"
sed \
  -e "s|__NPX_PATH__|${NPX_PATH}|g" \
  -e "s|__REPO_ROOT__|${REPO_ROOT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__PATH__|${CURRENT_PATH}|g" \
  -e "s|__GITHUB_TOKEN__|${GITHUB_TOKEN}|g" \
  -e "s|__RUNFORGE_DATABASE_URL__|${RUNFORGE_DATABASE_URL_VALUE}|g" \
  -e "s|__DAEMON_DATA_BACKEND__|${DAEMON_DATA_BACKEND_VALUE}|g" \
  -e "s|__ENCRYPTION_KEY__|${ENCRYPTION_KEY_VALUE}|g" \
  -e "s|__RUNFORGE_CONTROL_TOKEN__|${RUNFORGE_CONTROL_TOKEN_VALUE}|g" \
  "$PLIST_SRC" > "$PLIST_TMP"
mv "$PLIST_TMP" "$PLIST_DST"

# 4. Load and start
log "Loading daemon plist..."
launchctl load "$PLIST_DST"

log "Done. Verify with: launchctl list | grep runforge"
log "Logs: tail -f $LOG_DIR/claude-daemon.log"
log "Health: $REPO_ROOT/scripts/health.sh"
