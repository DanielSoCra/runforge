# Running Auto-Claude

## Architecture

Auto-Claude consists of these runtime components:

- **daemon** (`packages/daemon`) — polls GitHub for issues, spawns Claude workers, manages state
- **dashboard** (`packages/dashboard`) — Next.js web UI
- **postgres** — project-owned operational store used during the Supabase parity migration
- **migrate** — one-shot job that applies app-owned database migrations before consumers start

During the #626 migration, Supabase can still be the parity source of truth for dashboard/run data, but app-owned Postgres is required for credential storage and the replacement store layer.

## Prerequisites

- Docker and Docker Compose
- A [Supabase](https://supabase.com) project (free tier works)
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
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase `anon` key (public) |
| `SUPABASE_URL` | Yes | Same as above (daemon-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase `service_role` key (server-only) |
| `POSTGRES_DB` | Yes | Compose-managed Postgres database name |
| `POSTGRES_USER` | Yes | Compose-managed Postgres user |
| `POSTGRES_PASSWORD` | Yes | Compose-managed Postgres password |
| `POSTGRES_PORT` | No | Host bind for native tools/daemon; defaults to `127.0.0.1:5432:5432` |
| `AUTO_CLAUDE_DOCKER_DATABASE_URL` | Yes | Database URL used inside Docker services; host must be `postgres` |
| `AUTO_CLAUDE_DATABASE_URL` | Mac native daemon only | Database URL used by a daemon running outside Docker; host is usually `127.0.0.1` |
| `DAEMON_DATA_BACKEND` | No | `supabase` during parity, `postgres` after daemon cutover |
| `BRIEFING_DATA_BACKEND` | No | `supabase` during parity, `postgres` after briefing cutover |
| `NEXT_PUBLIC_SITE_URL` | Yes | Full URL of the dashboard (for OAuth redirects) |
| `DAEMON_URL` | Yes | Internal URL to reach the daemon (`http://daemon:3847` in Docker) |
| `ENCRYPTION_KEY` | Yes | 32+ character secret for encrypting stored credentials |
| `GITHUB_OAUTH_CLIENT_ID` | Yes | GitHub OAuth App client ID for repository connections |
| `GITHUB_OAUTH_CLIENT_SECRET` | Yes | GitHub OAuth App client secret for repository connections |

### Daemon config

```bash
cp auto-claude.config.example.json auto-claude.config.json
# Edit: set repo.owner and repo.name at minimum
```

Key fields in `auto-claude.config.json`:

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
# Fill in Supabase credentials and DAEMON_URL=http://localhost:3847
pnpm dev
```

Dashboard runs at `http://localhost:3000`.

**Daemon:**

```bash
# From repo root
cp .env.prod.example .env
# Fill in GITHUB_TOKEN, ANTHROPIC_API_KEY, Supabase vars

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

## Running on Mac Mini

The Mac Mini uses a **hybrid deployment**: dashboard and briefing-summarizer run in Docker, but the daemon runs natively (via launchd or direct process). This is because the daemon spawns Claude Code CLI sessions that require Max subscription OAuth tokens — these expire and can't be refreshed inside a container.

```bash
# 1. Start the daemon natively (if not already running via launchd)
cd packages/daemon && pnpm start &

# 2. Start Postgres, migrations, dashboard, and briefing-summarizer in Docker
ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d
```

Dashboard is available at `http://localhost:3000` on the local network. Auth is disabled. The dashboard connects to the native daemon via `host.docker.internal:3847`.

## Database Migrations

The Compose stack starts a `migrate` job that applies app-owned Postgres migrations from `packages/db/drizzle/` before dashboard, daemon, or briefing-summarizer start.

During Supabase parity, existing Supabase migrations still need to be present in the hosted project for hosted-backed data paths. App-owned Postgres is the credential/store migration path and becomes the sole operational store after cutover.

Apply migrations from `supabase/migrations/` to your Supabase project before first run. Run them in order via the Supabase SQL editor or:

```bash
# Via Supabase CLI (if configured)
supabase db push
```

## How It Works

1. The daemon polls the configured GitHub repo for issues labelled `ready`.
2. On finding one, it swaps the label to `in-progress` and spawns a Claude worker.
3. The worker implements the issue on a feature branch, runs validation checks, then opens a PR.
4. Run state (status, cost, logs) syncs to Supabase in real time.
5. The dashboard displays active runs, repo status, and operator controls.

## Daemon Mode

The daemon control plane (`auto-claude start`) replaces the legacy shell scripts (`scripts/pipeline.sh`, `scripts/developer.sh`, `scripts/reviewer.sh`). A single process now handles all work detection modes:

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
auto-claude start -c /path/to/auto-claude.config.json
```

### Process supervision (macOS)

On macOS, use the provided install script to set up a single launchd plist that keeps the daemon running. This replaces the 3 legacy shell-script plists (pipeline, developer, reviewer).

```bash
# Install: unloads legacy plists, substitutes env vars from .env.mac, loads daemon plist
./scripts/install-daemon.sh

# Verify
launchctl list | grep autoclaude
# Should show: com.autoclaude.daemon (single entry)

# Rollback (if needed)
./scripts/uninstall-daemon.sh
```

The install script reads `.env.mac` for `GITHUB_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, Supabase public keys, `AUTO_CLAUDE_DATABASE_URL`, `DAEMON_DATA_BACKEND`, and `ENCRYPTION_KEY`, then substitutes them into the plist template at `scripts/com.autoclaude.daemon.plist`.

The daemon writes a heartbeat file to `~/logs/claude-daemon.heartbeat` on each poll interval. Check it with:

```bash
./scripts/health.sh
```

**Plist details:**
- Label: `com.autoclaude.daemon`
- KeepAlive: `true` (restarts on crash)
- ThrottleInterval: 30 seconds (prevents rapid restart loops)
- Logs: `~/logs/claude-daemon.log`

### Operator commands

The daemon exposes a control API on `localhost:3847`:

```bash
auto-claude status          # Show active runs, daily cost, uptime
auto-claude pause           # Stop claiming new work (active runs finish)
auto-claude resume          # Resume claiming work
auto-claude retry <issue>   # Re-run a stuck issue from the beginning
auto-claude process <issue>  # Process a single issue (one-shot, no daemon)
auto-claude health          # Health check (for process supervisors)
```

### Work detection modes

The daemon polls the configured GitHub repo for issues and selects a pipeline variant based on labels and content:

- **Feature pipeline** — issues with a `feature-pipeline` label and spec references in the body. Full pipeline: detect, classify, decompose, implement, review, holdout, integrate, deploy, test, report.
- **Bug fix** — issues labelled as bugs. Streamlined: detect, diagnose, implement, review, integrate, deploy, test, report.
- **Codebase review** — not yet migrated to the daemon. Currently runs via `scripts/reviewer.sh`.

## Stopping

```bash
# Production
docker compose --env-file .env.prod --profile public down

# Development daemon
docker compose down
```

The daemon handles `SIGTERM` and `SIGINT` gracefully: stops accepting new work, waits for active runs to finish (up to 30 s), then exits.
