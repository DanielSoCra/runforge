# Deployment #0 — self-hosted governed daemon (reference)

A reference for running Runforge as a **governed, self-hosted daemon** ("deployment
#0") supervised by `launchd` on macOS. Everything host-specific lives in a
gitignored `deployment0.env` (template: `deployment0.env.example`); the scripts and
plist templates here are generic.

> This directory is the **versioned reference copy**. In practice you keep a live
> copy in an ops directory *outside* the runtime clone (the runtime-source validator
> requires the checkout to stay clean). No secrets live in these files — they source
> your env file at runtime.

## Layout

| Piece | What it is |
|---|---|
| Runtime source | A dedicated clean clone pinned to `origin/main` (`RUNFORGE_RUNTIME`). `state/` + `workspaces/` inside it are validator-ignored. The daemon never mutates its own source. |
| Database | This deployment's own Postgres DB (`RUNFORGE_DB_*`), reached via a running container (`RUNFORGE_PG_CONTAINER`). |
| Secrets | Sourced from your env file (`RUNFORGE_ENV_FILE`): `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `GITHUB_TOKEN` fallback. `gh auth token` is preferred when available. |
| `launch-deployment0.sh` | What `launchd` execs: sets the DB URL + governed-boot env, then starts the daemon from the runtime clone. |
| `promote.sh` | The operator-gated self-update path: stop → fast-forward runtime to `origin/main` → back up DB → migrate → restart → health-gate. Rolls back on failure. |
| `health-poll.sh` | External `/health` poller (closes the "wedged but alive" gap `launchd` KeepAlive can't see); logs + macOS notification on state transitions. |
| `com.runforge.daemon0.plist` / `com.runforge.health0.plist` | launchd templates with `__OPS_DIR__` / `__HOME__` / `__PATH__` placeholders, rendered at install by `promote.sh`. |

## Setup (once)

```bash
# 1. Dedicated runtime clone + an ops dir outside it
git clone <this-repo> ~/code/runforge-runtime
mkdir -p ~/code/runforge-ops/logs

# 2. Copy the ops files + fill in your coordinates
cp promote.sh launch-deployment0.sh health-poll.sh \
   com.runforge.daemon0.plist com.runforge.health0.plist \
   deployment0.env.example ~/code/runforge-ops/
cd ~/code/runforge-ops
cp deployment0.env.example deployment0.env && $EDITOR deployment0.env   # set paths/DB/labels

# 3. First promote installs + loads the launchd jobs and starts the daemon
./promote.sh
```

## Start / stop

```bash
launchctl load   ~/Library/LaunchAgents/com.runforge.daemon0.plist   # start + keep alive
launchctl load   ~/Library/LaunchAgents/com.runforge.health0.plist   # start health poller
launchctl unload ~/Library/LaunchAgents/com.runforge.health0.plist   # stop poller before planned shutdown
launchctl unload ~/Library/LaunchAgents/com.runforge.daemon0.plist   # stop supervision + daemon
curl -fsS localhost:3847/health   # 200 ok | 200 degraded | 503 unhealthy
curl -fsS localhost:3847/status | jq .
```

Emergency: `curl -X POST localhost:3847/halt -H 'X-Requested-By: operator'` (parks
runs, kills workers; `/resume` re-admits). See `docs/running.md`.

## Promote a new version (the only self-update path)

```bash
cd ~/code/runforge-ops && ./promote.sh
```

`promote.sh` quiesces the daemon, fast-forwards the runtime clone to `origin/main`,
takes an in-container DB backup, runs migrations, re-renders + reloads the launchd
plists, and gates on `/health`. Any failure after the daemon is stopped triggers an
automatic rollback (DB restore + runtime reset + restart).

## Notes

- **Postgres dump/restore run in-container** (`docker exec … pg_dump`) so a
  host/server client-version mismatch never blocks a promote.
- **The DB role and container name are independent of the DB name** — set each in
  `deployment0.env` to match your actual container.
- The health gate accepts a known non-fatal `alert-channel-degraded` state; any
  other degraded reason holds the promote.
