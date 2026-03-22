# Running Auto-Claude

## Architecture

Auto-Claude consists of two packages:

- **daemon** (`packages/daemon`) — polls GitHub for issues, spawns Claude workers, manages state
- **dashboard** (`packages/dashboard`) — Next.js web UI backed by Supabase

Both share a Supabase database. The daemon writes run state; the dashboard reads and displays it.

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
| `NEXT_PUBLIC_SITE_URL` | Yes | Full URL of the dashboard (for OAuth redirects) |
| `DAEMON_URL` | Yes | Internal URL to reach the daemon (`http://daemon:3847` in Docker) |
| `ENCRYPTION_KEY` | Yes | 32+ character secret for encrypting stored credentials |
| `GITHUB_REPO_OAUTH_APP_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_REPO_OAUTH_APP_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |

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

Three containers start:

| Container | Role |
|-----------|------|
| `daemon` | Claude worker orchestrator |
| `dashboard` | Next.js web UI |
| `caddy` | Reverse proxy + automatic TLS |

Dashboard is available at `https://app.example.com` (or your configured domain).

## Running on Mac Mini

The Mac Mini uses a **hybrid deployment**: dashboard and briefing-summarizer run in Docker, but the daemon runs natively (via launchd or direct process). This is because the daemon spawns Claude Code CLI sessions that require Max subscription OAuth tokens — these expire and can't be refreshed inside a container.

```bash
# 1. Start the daemon natively (if not already running via launchd)
cd packages/daemon && pnpm start &

# 2. Start dashboard + briefing-summarizer in Docker
ENV_FILE=.env.mac docker compose --env-file .env.mac up --build -d
```

Dashboard is available at `http://localhost:3000` on the local network. Auth is disabled. The dashboard connects to the native daemon via `host.docker.internal:3847`.

## Supabase Migrations

Apply migrations from `packages/daemon/migrations/` to your Supabase project before first run. Run them in order via the Supabase SQL editor or:

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

## Stopping

```bash
# Production
docker compose --env-file .env.prod --profile public down

# Development daemon
docker compose down
```

The daemon handles `SIGTERM` and `SIGINT` gracefully: stops accepting new work, waits for active runs to finish (up to 30 s), then exits.
