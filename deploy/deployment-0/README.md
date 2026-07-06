# auto-claude deployment #0 — ops (Mac mini)

The governed self-hosted auto-claude daemon ("deployment #0"), set up 2026-07-03
during the Phase-9 live self-run. This directory holds everything that must live
OUTSIDE the runtime checkout (the runtime-source validator requires the checkout
clean).

> **This is the versioned reference copy.** The live, running copies are deployed
> at `~/code/auto-claude-ops/` on the Mac mini (kept outside the runtime clone on
> purpose). Paths below are specific to that host; adapt for another machine. No
> secrets live in these files — they source `.env.mac` at runtime.

## Layout

| Piece | Where |
|---|---|
| Runtime source | `~/code/auto-claude-runtime` — dedicated clean clone, pinned to `origin/main`. `state/` + `workspaces/` inside it are validator-ignored. |
| Database | `autoclaude_prod0` on the compose Postgres (`127.0.0.1:45432`, container `auto-claude-postgres-1`). Fresh DB, drizzle-migrated. The old `autoclaude` DB is untouched. |
| Secrets | Sourced from `~/code/auto-claude/.env.mac` (ENCRYPTION_KEY, POSTGRES_PASSWORD, GITHUB_TOKEN fallback). `gh auth token` preferred when available. |
| Launch | `launch-deployment0.sh` (sets `AUTO_CLAUDE_DECISION_INDEX_ENABLED=1`, `DAEMON_DATA_BACKEND=postgres`, prod0 DB URL) |
| Supervision | `com.autoclaude.daemon0.plist` (KeepAlive; label distinct from legacy `com.autoclaude.daemon` so `scripts/install-daemon.sh` never clobbers it) |
| Health monitor | `com.autoclaude.health0.plist` → `health-poll.sh` every 5 min → `logs/health.log`, transitions → `logs/alerts.log` + macOS notification |
| Daemon log | `logs/daemon0.log` (also: heartbeat at `~/logs/claude-daemon.heartbeat`) |

## Start / stop

```bash
launchctl load  ~/Library/LaunchAgents/com.autoclaude.daemon0.plist   # start + keep alive
launchctl load  ~/Library/LaunchAgents/com.autoclaude.health0.plist   # start external /health poller
launchctl unload ~/Library/LaunchAgents/com.autoclaude.health0.plist  # stop poller before planned shutdown
launchctl unload ~/Library/LaunchAgents/com.autoclaude.daemon0.plist  # stop supervision + daemon
curl -fsS localhost:3847/health   # 200 ok | 200 degraded | 503 unhealthy
curl -fsS localhost:3847/status | jq .
```

Emergency: `curl -X POST localhost:3847/halt -H 'X-Requested-By: operator'` (parks
runs, kills workers; `/resume` re-admits). See `docs/running.md` in the repo.

## Promote a new auto-claude version (the ONLY self-update path)

```bash
~/code/auto-claude-ops/promote.sh
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
  is empty in `auto-claude.config.json`. Alerts are logged, not delivered.
  Choosing a real alert channel (ntfy/Slack webhook) is an open Operator call;
  until then, `promote.sh` intentionally refuses to declare a promotion healthy.
- Budgets were raised from 5/2/5 to 50/15/50 (PR #842) — the old values made
  worker spawn structurally impossible (spec-implementer reserves budgetCap 10
  up front).
