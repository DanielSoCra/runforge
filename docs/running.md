# Running Runforge

## Architecture

Runforge consists of these runtime components:

- **daemon** (`packages/daemon`) — polls GitHub for issues, spawns Claude workers, manages state
- **dashboard** (`packages/dashboard`) — Next.js web UI
- **postgres** — project-owned operational store
- **migrate** — one-shot job that applies app-owned database migrations before consumers start

Runforge now runs from the app-owned Postgres store. The dashboard uses Better Auth with application-owned authorization roles; the daemon, dashboard, and briefing summarizer all use direct Postgres-backed stores.

## Prerequisites

- Docker and Docker Compose
- GitHub personal access token with `repo` scope
- Anthropic API key

## Configuration

### Environment

Copy the example and fill in your values:

```bash
cp .env.prod.example .env.prod
```

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `POSTGRES_DB` | Yes | Compose-managed Postgres database name |
| `POSTGRES_USER` | Yes | Compose-managed Postgres user |
| `POSTGRES_PASSWORD` | Yes | Compose-managed Postgres password |
| `POSTGRES_PORT` | No | Host bind for native tools/daemon; defaults to `127.0.0.1:5432:5432` |
| `RUNFORGE_DOCKER_DATABASE_URL` | Yes | Database URL used inside Docker services; host must be `postgres` |
| `RUNFORGE_DATABASE_URL` | Mac native daemon only | Database URL used by a daemon running outside Docker; host is usually `127.0.0.1` |
| `DAEMON_DATA_BACKEND` | No | Must be `postgres`; unset defaults to `postgres` |
| `BRIEFING_DATA_BACKEND` | No | Must be `postgres`; unset defaults to `postgres` |
| `NEXT_PUBLIC_SITE_URL` | Yes | Full URL of the dashboard (for OAuth redirects) |
| `DAEMON_URL` | Yes | Internal URL to reach the daemon (`http://daemon:3847` in Docker) |
| `ENCRYPTION_KEY` | Yes | 32+ character secret for encrypting stored credentials |
| `GITHUB_OAUTH_CLIENT_ID` | Yes | GitHub OAuth App client ID for repository connections |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GitHub OAuth App client secret for repository connections |

### Daemon config

```bash
cp runforge.config.example.json runforge.config.json
# Edit: set repo.owner and repo.name at minimum
```

Key fields in `runforge.config.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `repo.owner` | — | GitHub repo owner (required) |
| `repo.name` | — | GitHub repo name (required) |
| `controlPort` | 3847 | HTTP control API port (internal only) |
| `pollIntervalMs` | 30000 | Issue polling interval (ms) |
| `maxConcurrentRuns` | 1 | Max parallel Claude workers |
| `dailyBudget` | 50 | Daily spending limit (USD) |
| `perRunBudget` | 10 | Per-issue spending limit (USD) |

## Running Locally (Development)

For local development, the dashboard has its own dev server and the daemon runs in Docker.

**Dashboard:**

```bash
cd packages/dashboard
cp .env.example .env.local
# Fill in DAEMON_URL=http://localhost:3847 and database/auth settings
pnpm dev
```

Dashboard runs at `http://localhost:3000`.

**Daemon:**

```bash
# From repo root
cp .env.prod.example .env
# Fill in GITHUB_TOKEN, ANTHROPIC_API_KEY, database, auth, and encryption vars

docker compose up --build
```

Daemon control API is available at `http://localhost:3847` (internal only; use the dashboard to interact).

## Running in Production

See [hetzner-setup.md](./hetzner-setup.md) for full server provisioning. Once configured:

```bash
docker compose --env-file .env.prod --profile public up --build -d
```

Core containers start:

| Container | Role |
|-----------|------|
| `postgres` | Self-hosted operational database |
| `migrate` | One-shot Drizzle migration runner |
| `daemon` | Claude worker orchestrator |
| `dashboard` | Next.js web UI |
| `caddy` | Reverse proxy + automatic TLS |

Dashboard is available at `https://app.example.com` (or your configured domain).

## Running on a macOS host

The macOS host uses a **hybrid deployment**: dashboard and briefing-summarizer run in Docker, but the daemon runs natively (via launchd or direct process). This is because the daemon spawns Claude Code CLI sessions that require Max subscription OAuth tokens — these expire and can't be refreshed inside a container.

```bash
# 1. Start the daemon natively (if not already running via launchd)
cd packages/daemon && pnpm start &

# 2. Start Postgres, migrations, dashboard, and briefing-summarizer in Docker
ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d
```

Dashboard is available at `http://localhost:3000` on the local network. Auth is disabled. The dashboard connects to the native daemon via `host.docker.internal:3847`.

## Database Migrations

The Compose stack starts a `migrate` job that applies app-owned Postgres migrations from `packages/db/drizzle/` before dashboard, daemon, or briefing-summarizer start.

## Backup and Restore

Back up the Postgres database with `pg_dump` from the Compose service. Keep the matching environment file and `ENCRYPTION_KEY` with the backup; encrypted credentials in the database cannot be read after restore without that key.

```bash
mkdir -p backups
docker compose --env-file .env.prod exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/runforge-$(date +%Y%m%d-%H%M%S).dump"
```

For a macOS host deployment, use `.env.mac` in the command above.

To restore, stop consumers first so no process writes while the database is being replaced. This overwrites the current database contents.

```bash
docker compose --env-file .env.prod stop dashboard briefing-summarizer
# If the daemon runs in Docker for this deployment:
docker compose --env-file .env.prod --profile containerized-daemon stop daemon

cat backups/runforge-YYYYMMDD-HHMMSS.dump | docker compose --env-file .env.prod exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner'

docker compose --env-file .env.prod up -d migrate dashboard briefing-summarizer
```

For a native Mac daemon, pause or unload launchd before restore, then reinstall or restart it after the database is restored.

## How It Works

1. The daemon polls the configured GitHub repo for issues labelled `ready`.
2. On finding one, it swaps the label to `in-progress` and spawns a Claude worker.
3. The worker implements the issue on a feature branch, runs validation checks, then opens a PR.
4. Run state (status, cost, logs) is written to the app-owned Postgres store.
5. The dashboard displays active runs, repo status, and operator controls.

## Daemon Mode

The daemon control plane (`runforge start`) replaces the legacy shell scripts (`scripts/pipeline.sh`, `scripts/developer.sh`, `scripts/reviewer.sh`). A single process now handles all work detection modes:

| Legacy script | Daemon equivalent |
|---------------|-------------------|
| `scripts/pipeline.sh` | Built-in feature pipeline variant (full FSM) |
| `scripts/developer.sh` | Built-in bug-fix variant |
| `scripts/reviewer.sh` | Not yet migrated — still runs as a standalone script |

### Starting the daemon

```bash
# Via pnpm (development)
cd packages/daemon && pnpm start

# Via CLI directly
npx tsx packages/daemon/src/main.ts start

# With custom config
runforge start -c /path/to/runforge.config.json
```

### Process supervision (macOS)

On macOS, use the provided install script to set up a single launchd plist that keeps the daemon running. This replaces the 3 legacy shell-script plists (pipeline, developer, reviewer).

```bash
# Install: unloads legacy plists, substitutes env vars from .env.mac, loads daemon plist
./scripts/install-daemon.sh

# Verify
launchctl list | grep runforge
# Should show: com.runforge.daemon (single entry)

# Rollback (if needed)
./scripts/uninstall-daemon.sh
```

The install script reads `.env.mac` for `GITHUB_TOKEN`, `RUNFORGE_DATABASE_URL`, `DAEMON_DATA_BACKEND`, and `ENCRYPTION_KEY`, then substitutes them into the plist template at `scripts/com.runforge.daemon.plist`.

> **Governed deployment requirement.** If your `runforge.config.json` contains a `deployment` block, the daemon will **refuse to boot at runtime** unless `RUNFORGE_DECISION_INDEX_ENABLED=1` is present in its environment — fail-closed by design. The install script does **not** wire this variable automatically from `.env.mac`; the plist template has no placeholder for it. For a governed launchd deployment, add it manually to the `EnvironmentVariables` dict in the generated plist (`~/Library/LaunchAgents/com.runforge.daemon.plist`) after running the install script, then reload:
> ```bash
> launchctl unload ~/Library/LaunchAgents/com.runforge.daemon.plist
> launchctl load  ~/Library/LaunchAgents/com.runforge.daemon.plist
> ```
> See [Self-hosting posture](#self-hosting-posture) for details on why this guard exists.

The daemon writes a heartbeat file to `~/logs/claude-daemon.heartbeat` on each poll interval. Check it with:

```bash
./scripts/health.sh
```

**Plist details:**
- Label: `com.runforge.daemon`
- KeepAlive: `true` (restarts on crash)
- ThrottleInterval: 30 seconds (prevents rapid restart loops)
- Logs: `~/logs/claude-daemon.log`

> **Crash-loop caveat (KeepAlive + ThrottleInterval).** With `KeepAlive=true`,
> launchd respawns the daemon on every hard exit, and `ThrottleInterval=30`
> only spaces restarts 30 s apart — it does **not** stop them. A *permanent*
> failure (a categorical `rejected` config outcome, a recurring
> `uncaughtException`, a bad migration) will therefore restart every ~30 s
> indefinitely. The daemon now notifies the configured alert channel on an
> uncaught crash and exits with a non-zero code, but launchd will still
> respawn — watch `~/logs/claude-daemon.log` and the alert channel for a
> repeating crash and fix the root cause (or `launchctl unload` the plist)
> rather than relying on the throttle to "settle" it.

### Unattended monitoring (REQUIRED for a governed deployment)

The daemon's `/health` endpoint reports a truthful three-state liveness signal
so an external monitor can detect a wedged or degraded daemon that the process
supervisor alone cannot see (a hung-but-alive process keeps launchd happy):

```bash
curl -fsS localhost:3847/health   # 200 ok | 200 degraded | 503 unhealthy
```

- **200 `{ok:true, degraded:false}`** — normal.
- **200 `{ok:true, degraded:true}`** — observable but intentional/transient: a
  manual pause, draining, the startup-degraded window, a governed deployment
  with **no** configured alert channel, or a transient alert-send failure.
- **503 `{ok:false}`** — unsafe / no forward progress: the consecutive-stuck
  threshold was hit, the work-loop **watchdog** detected a stall (a run or poll
  that stopped progressing past the idle-timeout — the daemon self-pauses but
  the held concurrency slot is NOT auto-released; **restart the daemon to
  recover it**), a **governed** deployment whose decision index failed at
  runtime, or a safety auto-pause.

**Operator prerequisite (Codex Q7): a governed/unattended deployment MUST
configure an external monitor that polls `/health`** (e.g. healthchecks.io, a
launchd/cron `curl` job, or an uptime monitor) and alerts on a non-200. The
in-process supervisor (launchd `KeepAlive`) restarts a *crashed* process but
cannot observe a *wedged* one — `/health` 503 + the external monitor is what
closes the "goes dark" gap until the deferred outbound dead-man's-switch (B3)
lands. A governed deployment should also configure at least one `webhook` (else
it boots `degraded:true` with a loud warning and auto-pause/escalation/crash
alerts are logged locally instead of delivered).

### Emergency stop: halt, pause, drain, and SIGUSR2

The daemon provides several ways to stop or slow work. They differ in urgency and what happens to runs already in progress:

| Control | Effect on new work | Effect on in-progress runs | How to resume |
|---------|-------------------|---------------------------|---------------|
| `POST /pause` | Stops claiming new issues. | Active runs continue to completion. | `POST /resume` |
| `POST /halt` | Stops claiming new issues (same as pause). | Parks each in-flight run at its current phase, then SIGTERM→SIGKILL terminates worker processes with a 5 s grace period. The halt interlock stays latched until `/resume`; any run that settles after the 15 s bounded wait still parks instead of advancing. | `POST /resume` re-admits halt-parked runs at `pausedAtPhase`. |
| `POST /drain` | Stops claiming new issues. | Lets active runs finish, then the daemon exits. | Restart the daemon. |
| `SIGUSR2` | Stops claiming new issues. | Active runs finish; daemon exits when idle. | Restart the daemon. |

Use `/pause` when you want the daemon to stop picking up work but let current runs finish normally. Use `/halt` for an emergency stop: it parks runs immediately so they can resume later, kills workers that do not terminate gracefully within 5 seconds, and remains latched so late-settling runs cannot advance past the park. `/resume` clears the halt latch as well as the pause.

```bash
# Emergency halt (requires X-Requested-By; Bearer token if RUNFORGE_CONTROL_TOKEN is set)
curl -fsS -X POST localhost:3847/halt \
  -H 'X-Requested-By: operator' \
  -H 'Authorization: Bearer <token>'

# Pause / resume
curl -fsS -X POST localhost:3847/pause -H 'X-Requested-By: operator'
curl -fsS -X POST localhost:3847/resume -H 'X-Requested-By: operator'
```

A paused daemon also gates integrate entry: a run that reaches the `integrate` phase while paused is parked at `pausedAtPhase: 'integrate'` instead of merging, then resumes through the normal integrate arm after `/resume`.

### Operator commands

The daemon exposes a control API on `localhost:3847`:

```bash
runforge status          # Show active runs, daily cost, uptime
runforge pause           # Stop claiming new work (active runs finish)
runforge resume          # Resume claiming work
runforge retry <issue>   # Re-run a stuck issue from the beginning
runforge process <issue>  # Process a single issue (one-shot, no daemon)
runforge health          # Health check (for process supervisors)
```

### Work detection modes

The daemon polls the configured GitHub repo for issues and selects a pipeline variant based on labels and content:

- **Feature pipeline** — issues with a `feature-pipeline` label and spec references in the body. Full pipeline: detect, classify, decompose, implement, review, holdout, integrate, deploy, test, report.
- **Bug fix** — issues labelled as bugs. Streamlined: detect, diagnose, implement, review, integrate, deploy, test, report.
- **Codebase review** — not yet migrated to the daemon. Currently runs via `scripts/reviewer.sh`.

### Self-hosting posture

When the daemon governs its own repo (deployment #0), there is no external
sandbox: HEAD can move under the running process. The following posture makes
that safe:

- **Validate at boot and every claim.** `runtimeSource.expectedRef` is pinned to
  `origin/main`. `validateRuntimeSource` runs before prompt pre-warming and work
  detection; an unhealthy runtime source pauses the daemon (configurable via
  `onUnhealthy`) rather than proceeding against a dirty or stale checkout.
- **Pause on unhealthy.** A runtime-source failure sets the daemon degraded and
  stops new claims. The operator must reconcile the checkout before work resumes.
- **Self-changes land only as PRs.** The running tree is never mutated in-place.
  Implementation, review, and merge all happen in worktrees and feature branches.
- **Operator-gated restart is the only self-update path.** Promotion of a new
  runforge version is the restart: the operator runs the repository's
  `release.sh` (the configured `landing.productionReleasePath`) and restarts the
  daemon from the fresh checkout. The daemon does not rewrite its own source or
  binary while running.
- **Governed boot requires the decision index.** With a `deployment` block present,
  the daemon refuses to boot unless the decision index is available
  (`RUNFORGE_DECISION_INDEX_ENABLED=1` + a reachable `RUNFORGE_DATABASE_URL`).
  This is fail-closed by design: a governed deployment that cannot surface
  escalations to the Operator must not run silently ungoverned. Set both before
  starting the self-hosting daemon, or boot will refuse — loudly — rather than
  proceed.

This replaces physical isolation with runtime-source hygiene, explicit pause
semantics, and a human-in-the-loop promotion step.

## Stopping

```bash
# Production
docker compose --env-file .env.prod --profile public down

# Development daemon
docker compose down
```

The daemon handles `SIGTERM` and `SIGINT` gracefully: stops accepting new work, waits for active runs to finish (up to 30 s), then exits.
