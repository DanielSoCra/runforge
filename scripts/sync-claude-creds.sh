#!/usr/bin/env bash
#
# sync-claude-creds.sh — keep a containerized daemon's subscription auth fresh
# WITHOUT giving the container its own OAuth refresh cycle (which would rotate
# the shared refresh-token and break the host's `claude` login).
#
# The macOS Keychain is the single source of truth: the host `claude` CLI owns
# the refresh cycle, this script copies the *current* credential into the creds
# dir the daemon container mounts at /root/.claude. Run it on a short interval
# (default launchd: every 15 min) so the container's access-token is always
# fresh from the host and the container never needs to refresh on its own.
#
# Usage:
#   sync-claude-creds.sh [CREDS_DIR]
#   RUNFORGE_CREDS_DIR=/path/to/creds sync-claude-creds.sh
#
# CREDS_DIR is the host directory bind-mounted to /root/.claude in the daemon
# (i.e. RUNFORGE_CLAUDE_CREDS_DIR). The script writes <CREDS_DIR>/.credentials.json.
#
# Secrets: the credential JSON is NEVER printed. Only success/length metadata
# is logged. The output file is written 0600 via a temp file + atomic rename.

set -euo pipefail

KEYCHAIN_SERVICE="Claude Code-credentials"
# The service has several accounts (e.g. "unknown"/"instance-default" hold only
# mcpOAuth); the subscription credential (claudeAiOauth) is stored under the
# macOS username. Override with RUNFORGE_KEYCHAIN_ACCOUNT if yours differs.
KEYCHAIN_ACCOUNT="${RUNFORGE_KEYCHAIN_ACCOUNT:-$(id -un)}"
CREDS_DIR="${1:-${RUNFORGE_CREDS_DIR:-}}"

if [[ -z "${CREDS_DIR}" ]]; then
  echo "sync-claude-creds: no CREDS_DIR given (arg 1 or RUNFORGE_CREDS_DIR)" >&2
  exit 2
fi

# Ensure the launchd log dir exists (the plist writes Standard{Out,Error}Path to
# ~/logs; launchd silently drops output if the dir is missing).
mkdir -p "${HOME}/logs" 2>/dev/null || true

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') sync-claude-creds: $*"; }

# 1. Extract the current credential from the Keychain (the secret stays in the
#    var; never echoed). Fails loudly if the Keychain entry is missing/locked.
if ! creds_json="$(security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w 2>/dev/null)"; then
  log "ERROR keychain entry '${KEYCHAIN_SERVICE}' (account '${KEYCHAIN_ACCOUNT}') not found or locked — is the host 'claude' logged in?"
  exit 1
fi

# 2. Validate shape (access token present) WITHOUT printing the secret.
if ! printf '%s' "${creds_json}" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
    tok = d.get("claudeAiOauth", {}).get("accessToken")
    exp = d.get("claudeAiOauth", {}).get("expiresAt")
    assert isinstance(tok, str) and len(tok) > 20
    print(f"OK accessToken len={len(tok)} expiresAt={exp}", file=sys.stderr)
except Exception as e:
    print(f"INVALID creds json: {e}", file=sys.stderr); sys.exit(1)
' 2>>/tmp/sync-claude-creds.validate; then
  log "ERROR keychain credential did not validate (see /tmp/sync-claude-creds.validate)"
  exit 1
fi

# 3. Atomic, 0600 write into the mounted creds dir.
mkdir -p "${CREDS_DIR}"
target="${CREDS_DIR}/.credentials.json"
tmp="$(mktemp "${CREDS_DIR}/.credentials.json.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
printf '%s' "${creds_json}" >"${tmp}"
chmod 600 "${tmp}"
mv -f "${tmp}" "${target}"
trap - EXIT

# expiresAt is epoch-ms; surface minutes-remaining for the log (no secret).
mins="$(python3 -c '
import json,sys,time
d=json.load(open(sys.argv[1]))
exp=d["claudeAiOauth"].get("expiresAt")
print(int((exp/1000 - time.time())/60) if exp else "n/a")
' "${target}" 2>/dev/null || echo "n/a")"
log "synced -> ${target} (token valid ~${mins} min)"
