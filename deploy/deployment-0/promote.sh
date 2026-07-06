#!/usr/bin/env bash
# Promote deployment #0 to the current origin/main and (re)start under launchd.
# This is the documented "operator-gated restart" self-update path.
set -euo pipefail

OPS=~/code/auto-claude-ops
RUNTIME=~/code/auto-claude-runtime
ENV_MAC=~/code/auto-claude/.env.mac
LOG_DIR="$OPS/logs"
DAEMON_PLIST_SRC="$OPS/com.autoclaude.daemon0.plist"
DAEMON_PLIST_DST="$HOME/Library/LaunchAgents/com.autoclaude.daemon0.plist"
HEALTH_PLIST_SRC="$OPS/com.autoclaude.health0.plist"
HEALTH_PLIST_DST="$HOME/Library/LaunchAgents/com.autoclaude.health0.plist"
OLD_REV="$(git -C "$RUNTIME" rev-parse HEAD)"
DAEMON_STOPPED=0
DB_BACKUP=""

mkdir -p "$LOG_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_MAC"
set +a
export AUTO_CLAUDE_DATABASE_URL="postgres://autoclaude:${POSTGRES_PASSWORD}@127.0.0.1:45432/autoclaude_prod0"

start_supervision() {
  cp "$DAEMON_PLIST_SRC" "$DAEMON_PLIST_DST"
  cp "$HEALTH_PLIST_SRC" "$HEALTH_PLIST_DST"
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
    if ! pg_restore --clean --if-exists --no-owner --dbname "$AUTO_CLAUDE_DATABASE_URL" "$DB_BACKUP"; then
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

command -v pg_dump >/dev/null || { echo "[promote] pg_dump is required for rollback-safe migrations"; exit 1; }
command -v pg_restore >/dev/null || { echo "[promote] pg_restore is required for rollback-safe migrations"; exit 1; }
command -v jq >/dev/null || { echo "[promote] jq is required to verify non-degraded health"; exit 1; }

echo "[promote] stopping supervision + daemon..."
launchctl unload "$HEALTH_PLIST_DST" 2>/dev/null || true
launchctl unload "$DAEMON_PLIST_DST" 2>/dev/null || true
DAEMON_STOPPED=1
for _ in $(seq 1 40); do
  PID="$(lsof -ti :3847 || true)"
  [ -z "$PID" ] && break
  sleep 1
done
if [ -n "${PID:-}" ]; then
  echo "[promote] port 3847 is still in use after launchd unload by PID(s): $PID; refusing to kill an unknown process"
  exit 1
fi

echo "[promote] updating runtime source to origin/main..."
git -C "$RUNTIME" fetch origin main
git -C "$RUNTIME" checkout -B main origin/main
git -C "$RUNTIME" reset --hard origin/main
clean_runtime_source
(cd "$RUNTIME" && pnpm install --frozen-lockfile --prefer-offline | tail -1)
git -C "$RUNTIME" log --oneline -1

DB_BACKUP="$(mktemp -t auto-claude-prod0-backup.XXXXXX.dump)"
echo "[promote] backing up quiesced prod0 database..."
if ! pg_dump --format=custom --file "$DB_BACKUP" "$AUTO_CLAUDE_DATABASE_URL"; then
  rm -f "$DB_BACKUP"
  DB_BACKUP=""
  exit 1
fi

echo "[promote] applying database migrations..."
(cd "$RUNTIME" && pnpm --filter @auto-claude/db run db:migrate)

echo "[promote] starting under launchd..."
start_supervision

for _ in $(seq 1 30); do
  sleep 2
  if OUT="$(curl -sS -m 5 localhost:3847/health 2>/dev/null)"; then
    if printf '%s' "$OUT" | jq -e '.ok == true and .degraded == false' >/dev/null; then
      echo "[promote] health: $OUT"
      exit 0
    fi
    echo "[promote] health not ready: $OUT"
  fi
done
echo "[promote] daemon did not become healthy in 60s — check $OPS/logs/daemon0.log"
exit 1
