#!/bin/bash
# uninstall-daemon.sh — Unload the daemon plist for rollback.
set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.autoclaude.daemon.plist"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

if [ ! -f "$PLIST_DST" ]; then
  log "Daemon plist not found at $PLIST_DST — nothing to unload."
  exit 0
fi

log "Unloading daemon plist..."
launchctl unload "$PLIST_DST" 2>/dev/null && log "Unloaded successfully" || log "WARN: Could not unload (may not be loaded)"

log "Removing plist file..."
rm -f "$PLIST_DST"

log "Done. To restore legacy scripts, re-load them manually:"
log "  launchctl load ~/Library/LaunchAgents/com.autoclaude.pipeline.plist"
log "  launchctl load ~/Library/LaunchAgents/com.autoclaude.developer.plist"
log "  launchctl load ~/Library/LaunchAgents/com.autoclaude.reviewer.plist"
