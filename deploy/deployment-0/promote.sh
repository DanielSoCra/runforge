#!/usr/bin/env bash
# Promote deployment #0 to the current origin/main and (re)start under launchd.
# This is the documented "operator-gated restart" self-update path.
#
# All host-specific coordinates come from deployment0.env (see
# deployment0.env.example) sourced from this script's own directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
[ -f "$HERE/deployment0.env" ] && source "$HERE/deployment0.env"

OPS="${RUNFORGE_OPS:-$HERE}"
RUNTIME="${RUNFORGE_RUNTIME:?set RUNFORGE_RUNTIME in deployment0.env}"
ENV_FILE="${RUNFORGE_ENV_FILE:?set RUNFORGE_ENV_FILE in deployment0.env}"
DB_ROLE="${RUNFORGE_DB_ROLE:?set RUNFORGE_DB_ROLE in deployment0.env}"
DB_NAME="${RUNFORGE_DB_NAME:?set RUNFORGE_DB_NAME in deployment0.env}"
DB_HOST="${RUNFORGE_DB_HOST:-127.0.0.1}"
DB_PORT="${RUNFORGE_DB_PORT:-5432}"
PG_CONTAINER="${RUNFORGE_PG_CONTAINER:?set RUNFORGE_PG_CONTAINER in deployment0.env}"
PORT="${RUNFORGE_CONTROL_PORT:-3847}"
DAEMON_LABEL="${RUNFORGE_DAEMON_LABEL:-com.runforge.daemon0}"
HEALTH_LABEL="${RUNFORGE_HEALTH_LABEL:-com.runforge.health0}"

LOG_DIR="$OPS/logs"
DAEMON_PLIST_SRC="$OPS/${DAEMON_LABEL}.plist"
DAEMON_PLIST_DST="$HOME/Library/LaunchAgents/${DAEMON_LABEL}.plist"
HEALTH_PLIST_SRC="$OPS/${HEALTH_LABEL}.plist"
HEALTH_PLIST_DST="$HOME/Library/LaunchAgents/${HEALTH_LABEL}.plist"
[ -d "$RUNTIME" ] || { echo "ERROR: $RUNTIME missing — set RUNFORGE_RUNTIME / run the one-time setup in README.md first." >&2; exit 1; }
OLD_REV="$(git -C "$RUNTIME" rev-parse HEAD)"
DAEMON_STOPPED=0
DB_BACKUP=""

mkdir -p "$LOG_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export RUNFORGE_DATABASE_URL="postgres://${DB_ROLE}:${POSTGRES_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Render a launchd plist template (placeholders → real paths) into LaunchAgents.
render_plist() {
  sed \
    -e "s|__OPS_DIR__|${OPS}|g" \
    -e "s|__HOME__|${RUNFORGE_HOME:-$HOME}|g" \
    -e "s|__PATH__|${RUNFORGE_PATH:-$PATH}|g" \
    "$1" > "$2"
}

start_supervision() {
  render_plist "$DAEMON_PLIST_SRC" "$DAEMON_PLIST_DST"
  render_plist "$HEALTH_PLIST_SRC" "$HEALTH_PLIST_DST"
  launchctl load "$DAEMON_PLIST_DST"
  launchctl load "$HEALTH_PLIST_DST"
}

clean_runtime_source() {
  git -C "$RUNTIME" clean -fd \
    -e state/ \
    -e workspaces/ \
    -e .claude/scheduled_tasks.lock
}

rollback_on_failure() {
  status="$1"
  if [ "$status" -eq 0 ]; then
    [ -n "$DB_BACKUP" ] && rm -f "$DB_BACKUP"
    return
  fi
  if [ "$DAEMON_STOPPED" -ne 1 ]; then
    [ -n "$DB_BACKUP" ] && rm -f "$DB_BACKUP"
    return
  fi

  echo "[promote] failed after daemon stop; restoring DB backup, rolling runtime back to $OLD_REV, and restarting..."
  launchctl unload "$HEALTH_PLIST_DST" 2>/dev/null || true
  launchctl unload "$DAEMON_PLIST_DST" 2>/dev/null || true
  if [ -n "$DB_BACKUP" ]; then
    if ! docker exec -i "$PG_CONTAINER" pg_restore --clean --if-exists --no-owner -U "$DB_ROLE" -d "$DB_NAME" < "$DB_BACKUP"; then
      echo "[promote] DB restore failed; leaving supervision stopped for manual recovery from $DB_BACKUP" >&2
      return "$status"
    fi
    rm -f "$DB_BACKUP"
    DB_BACKUP=""
  fi
  if ! git -C "$RUNTIME" reset --hard "$OLD_REV"; then
    echo "[promote] runtime reset to $OLD_REV failed; leaving supervision stopped" >&2
    return "$status"
  fi
  if ! clean_runtime_source; then
    echo "[promote] runtime clean after rollback failed; leaving supervision stopped" >&2
    return "$status"
  fi
  if ! (cd "$RUNTIME" && pnpm install --frozen-lockfile --prefer-offline | tail -1); then
    echo "[promote] dependency install after rollback failed; leaving supervision stopped" >&2
    return "$status"
  fi
  if ! start_supervision; then
    echo "[promote] launchd restart after rollback failed; supervision is stopped" >&2
    return "$status"
  fi
}
trap 'rollback_on_failure "$?"' EXIT

docker exec "$PG_CONTAINER" pg_dump --version >/dev/null || { echo "[promote] container pg_dump unavailable (dump/restore always run in-container to avoid host/server version mismatch)"; exit 1; }
command -v jq >/dev/null || { echo "[promote] jq is required to verify non-degraded health"; exit 1; }

echo "[promote] stopping supervision + daemon..."
launchctl unload "$HEALTH_PLIST_DST" 2>/dev/null || true
launchctl unload "$DAEMON_PLIST_DST" 2>/dev/null || true
DAEMON_STOPPED=1
for _ in $(seq 1 40); do
  PID="$(lsof -ti ":$PORT" || true)"
  [ -z "$PID" ] && break
  sleep 1
done
if [ -n "${PID:-}" ]; then
  echo "[promote] port $PORT is still in use after launchd unload by PID(s): $PID; refusing to kill an unknown process"
  exit 1
fi

echo "[promote] updating runtime source to origin/main..."
git -C "$RUNTIME" fetch origin main
git -C "$RUNTIME" checkout -B main origin/main
git -C "$RUNTIME" reset --hard origin/main
clean_runtime_source
(cd "$RUNTIME" && pnpm install --frozen-lockfile --prefer-offline | tail -1)
git -C "$RUNTIME" log --oneline -1

DB_BACKUP="$(mktemp -t runforge-prod-backup.XXXXXX.dump)"
echo "[promote] backing up quiesced database..."
if ! docker exec -i "$PG_CONTAINER" pg_dump --format=custom -U "$DB_ROLE" "$DB_NAME" > "$DB_BACKUP"; then
  rm -f "$DB_BACKUP"
  DB_BACKUP=""
  exit 1
fi

echo "[promote] applying database migrations..."
(cd "$RUNTIME" && pnpm --filter @runforge/db run db:migrate)

echo "[promote] starting under launchd..."
start_supervision

for _ in $(seq 1 30); do
  sleep 2
  if OUT="$(curl -sS -m 5 "localhost:$PORT/health" 2>/dev/null)"; then
    if printf '%s' "$OUT" | jq -e '.ok == true and (.degraded == false or .reason == "alert-channel-degraded")' >/dev/null; then
      echo "[promote] health: $OUT"
      exit 0
    fi
    echo "[promote] health not ready: $OUT"
  fi
done
echo "[promote] daemon did not become healthy in 60s — check $LOG_DIR/daemon0.log"
exit 1
