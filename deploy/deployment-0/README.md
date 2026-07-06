# runforge deployment #0 — ops (Mac mini)

The governed self-hosted runforge daemon ("deployment #0"), set up 2026-07-03
during the Phase-9 live self-run. This directory holds everything that must live
OUTSIDE the runtime checkout (the runtime-source validator requires the checkout
clean).

> **This is the versioned reference copy.** The live, running copies are deployed
> at `~/code/runforge-ops/` on the Mac mini (kept outside the runtime clone on
> purpose). Paths below are specific to that host; adapt for another machine. No
> secrets live in these files — they source `.env.mac` at runtime.

## Layout

| Piece | Where |
|---|---|
| Runtime source | `~/code/runforge-runtime` — dedicated clean clone, pinned to `origin/main`. `state/` + `workspaces/` inside it are validator-ignored. |
| Database | `runforge_prod0` on the compose Postgres (`127.0.0.1:45432`, container `auto-claude-postgres-1` — compose project name stays pinned to the pre-rename value, see cutover §4b). Fresh DB, drizzle-migrated. The legacy `autoclaude` DB is untouched. |
| Secrets | Sourced from `~/code/runforge/.env.mac` (ENCRYPTION_KEY, POSTGRES_PASSWORD, GITHUB_TOKEN fallback). `gh auth token` preferred when available. |
| Launch | `launch-deployment0.sh` (sets `RUNFORGE_DECISION_INDEX_ENABLED=1`, `DAEMON_DATA_BACKEND=postgres`, prod0 DB URL) |
| Supervision | `com.runforge.daemon0.plist` (KeepAlive; label distinct from legacy `com.runforge.daemon` so `scripts/install-daemon.sh` never clobbers it) |
| Health monitor | `com.runforge.health0.plist` → `health-poll.sh` every 5 min → `logs/health.log`, transitions → `logs/alerts.log` + macOS notification |
| Daemon log | `logs/daemon0.log` (also: heartbeat at `~/logs/claude-daemon.heartbeat`) |

## Cutover from the pre-rename live box (REQUIRED once, before the next promote)

The live Mac mini was provisioned under the old project name. Every path, DB,
and launchd label below the old names still exists there; the tooling in this
directory now targets the new names. Until this one-time migration runs, the
live box and this tooling disagree — `promote.sh` will fail fast on the missing
`runforge-*` paths. Sequence (stop old, rename, start new — never run both):

```bash
# 1. Stop + remove the OLD launchd jobs (old labels)
launchctl unload ~/Library/LaunchAgents/com.autoclaude.daemon0.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.autoclaude.health0.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.autoclaude.*.plist

# 2. Rename dirs (runtime clone + ops + repo checkout with .env.mac)
mv ~/code/auto-claude-runtime ~/code/runforge-runtime
mv ~/code/auto-claude-ops     ~/code/runforge-ops
mv ~/code/auto-claude         ~/code/runforge   # holds .env.mac

# 3. Migrate env var names inside .env.mac (AUTO_CLAUDE_* → RUNFORGE_*)
sed -i '' 's/AUTO_CLAUDE_/RUNFORGE_/g' ~/code/runforge/.env.mac

# 4. Rename the prod DB (needs no active connections — daemon is stopped).
#    NOTE: the live container keeps its OLD compose-project name.
docker exec auto-claude-postgres-1 psql -U postgres -c \
  'ALTER DATABASE autoclaude_prod0 RENAME TO runforge_prod0;'

# 4b. Pin the compose project name BEFORE any future `docker compose up` from
#     the renamed dir — otherwise compose derives project "runforge" from the
#     new dir name and creates a PARALLEL postgres with an EMPTY volume.
echo 'COMPOSE_PROJECT_NAME=auto-claude' >> ~/code/runforge/.env

# 5. Refresh ops copies from this directory, then promote — promote.sh itself
#    installs the new plists into ~/Library/LaunchAgents and loads them
#    (do NOT launchctl load by hand; the plists aren't in LaunchAgents yet)
cp com.runforge.daemon0.plist com.runforge.health0.plist \
   launch-deployment0.sh health-poll.sh promote.sh ~/code/runforge-ops/
~/code/runforge-ops/promote.sh

# 6. Reinstall creds-sync — the OLD com.autoclaude.creds-sync job execs
#    ~/code/auto-claude/scripts/sync-claude-creds.sh, which the mv broke.
#    (If it silently dies, worker auth decays.) docker-autostart has no
#    renamed-path dependency; leave it.
launchctl unload ~/Library/LaunchAgents/com.autoclaude.creds-sync.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.autoclaude.creds-sync.plist
(cd ~/code/runforge && ./scripts/install-creds-sync.sh)
```

Notes:
- The GitHub repo rename (auto-claude → runforge) is a separate, Operator-owned
  step; `runforge.config.json` keeps the CURRENT GitHub repo name in its coords
  (redirects make old coords survive a rename, but a not-yet-renamed repo cannot
  be polled under the new name).
- Earned-autonomy / earn-in state is keyed by `deployment.id`, which this rename
  changes from `auto-claude` to `runforge`. On first boot the deployment
  re-registers under the new id and prior lane track-record is orphaned —
  autonomy resets to the conservative floor and must be re-earned (fail-closed,
  deliberate default). To carry trust forward instead, rewrite `deploymentId`
  in the governance state files under the runtime `state/` dir before first boot.

## Start / stop

```bash
launchctl load  ~/Library/LaunchAgents/com.runforge.daemon0.plist   # start + keep alive
launchctl load  ~/Library/LaunchAgents/com.runforge.health0.plist   # start external /health poller
launchctl unload ~/Library/LaunchAgents/com.runforge.health0.plist  # stop poller before planned shutdown
launchctl unload ~/Library/LaunchAgents/com.runforge.daemon0.plist  # stop supervision + daemon
curl -fsS localhost:3847/health   # 200 ok | 200 degraded | 503 unhealthy
curl -fsS localhost:3847/status | jq .
```

Emergency: `curl -X POST localhost:3847/halt -H 'X-Requested-By: operator'` (parks
runs, kills workers; `/resume` re-admits). See `docs/running.md` in the repo.

## Promote a new runforge version (the ONLY self-update path)

```bash
~/code/runforge-ops/promote.sh
```

The daemon never mutates its own source; it pauses if the checkout goes dirty or
falls behind `origin/main` (after the daemon itself merges a PR, its workspace
fetches update `origin/main` in the shared clone → the validator parks new claims
until you run the promote step above).

`promote.sh` exits successfully only after `/health` reports
`{ok:true, degraded:false}`. Resolve any degraded reason first — especially the
known missing alert channel below — or the script rolls back to the prior runtime
revision.

## Known state

- `/health` reports `degraded:true, reason:alert-channel-degraded` — `webhooks`
  is empty in `runforge.config.json`. Alerts are logged, not delivered.
  Choosing a real alert channel (ntfy/Slack webhook) is an open Operator call;
  until then, `promote.sh` intentionally refuses to declare a promotion healthy.
- Budgets were raised from 5/2/5 to 50/15/50 (PR #842) — the old values made
  worker spawn structurally impossible (spec-implementer reserves budgetCap 10
  up front).
