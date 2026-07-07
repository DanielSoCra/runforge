#!/usr/bin/env bash
# Deployment #0: governed self-hosted runforge daemon.
#
# Runtime source: a clean, dedicated clone pinned to origin/main
# (validateRuntimeSource requires clean + at/ahead of origin/main; state/ and
# workspaces/ inside it are ignored dirty paths). The daemon never mutates its
# own source — promote a new version with promote.sh (stop, fast-forward,
# migrate, restart).
#
# All host-specific coordinates come from deployment0.env (see
# deployment0.env.example). Copy that next to this script and fill it in.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
[ -f "$HERE/deployment0.env" ] && source "$HERE/deployment0.env"
RUNTIME="${RUNFORGE_RUNTIME:?set RUNFORGE_RUNTIME in deployment0.env}"
ENV_FILE="${RUNFORGE_ENV_FILE:?set RUNFORGE_ENV_FILE in deployment0.env}"
export PATH="${RUNFORGE_PATH:-$PATH}"

# Secrets (GITHUB_TOKEN fallback, ENCRYPTION_KEY, POSTGRES_PASSWORD) come from
# the operator env file — no duplicated secret store.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Deployment #0 overrides: dedicated DB + governed boot requirements.
export RUNFORGE_DATABASE_URL="postgres://${RUNFORGE_DB_ROLE:?}:${POSTGRES_PASSWORD}@${RUNFORGE_DB_HOST:-127.0.0.1}:${RUNFORGE_DB_PORT:-5432}/${RUNFORGE_DB_NAME:?}"
export DAEMON_DATA_BACKEND=postgres
export RUNFORGE_DECISION_INDEX_ENABLED=1

# Prefer a fresh gh CLI token when available (the env-file PAT is the fallback).
if command -v gh >/dev/null 2>&1; then
  FRESH_TOKEN="$(gh auth token 2>/dev/null || true)"
  [ -n "$FRESH_TOKEN" ] && export GITHUB_TOKEN="$FRESH_TOKEN"
fi

cd "$RUNTIME"
exec "$RUNTIME/packages/daemon/node_modules/.bin/tsx" \
  "$RUNTIME/packages/daemon/src/main.ts" start \
  --config "$RUNTIME/runforge.config.json"
