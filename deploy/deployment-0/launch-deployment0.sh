#!/usr/bin/env bash
# Deployment #0: runforge governed self-hosted daemon (Mac mini).
#
# Runtime source: ~/code/runforge-runtime — a clean, dedicated
# clone pinned to origin/main (validateRuntimeSource requires clean + at/ahead
# of origin/main; state/ and workspaces/ inside it are ignored dirty paths).
#
# To promote a new runforge version: stop the daemon, `git -C
# ~/code/runforge-runtime pull --ff-only && pnpm install
# --frozen-lockfile`, restart. The daemon never mutates its own source.
set -euo pipefail

RUNTIME=~/code/runforge-runtime
ENV_MAC=~/code/runforge/.env.mac
export PATH="/opt/homebrew/bin:~/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# Secrets (GITHUB_TOKEN fallback, ENCRYPTION_KEY, POSTGRES_PASSWORD) come from
# the existing Mac-mini env file — no duplicated secret store.
set -a
# shellcheck disable=SC1090
source "$ENV_MAC"
set +a

# Deployment #0 overrides: dedicated fresh DB + governed boot requirements.
export RUNFORGE_DATABASE_URL="postgres://runforge:${POSTGRES_PASSWORD}@127.0.0.1:45432/runforge_prod0"
export DAEMON_DATA_BACKEND=postgres
export RUNFORGE_DECISION_INDEX_ENABLED=1

# Prefer a fresh gh CLI token when available (the .env.mac PAT is the fallback).
if [ -x /opt/homebrew/bin/gh ]; then
  FRESH_TOKEN="$(/opt/homebrew/bin/gh auth token 2>/dev/null || true)"
  [ -n "$FRESH_TOKEN" ] && export GITHUB_TOKEN="$FRESH_TOKEN"
fi

cd "$RUNTIME"
exec "$RUNTIME/packages/daemon/node_modules/.bin/tsx" \
  "$RUNTIME/packages/daemon/src/main.ts" start \
  --config "$RUNTIME/runforge.config.json"
