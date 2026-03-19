# Running Auto-Claude

## Prerequisites

- Node.js 22+
- pnpm
- `claude` CLI installed and authenticated
- GitHub personal access token with `repo` scope
- Anthropic API key (for Docker) or Claude Max subscription (for local)

## Quick Start (Local)

```bash
# 1. Install dependencies
pnpm install

# 2. Create config
cp auto-claude.config.example.json auto-claude.config.json
# Edit auto-claude.config.json with your repo details

# 3. Start the daemon (uses your local Claude Max session)
GITHUB_TOKEN=ghp_your_token pnpm start -- -c auto-claude.config.json
```

## Docker Compose (Isolated)

```bash
# 1. Set your secrets
cp .env.example .env
# Edit .env:
#   GITHUB_TOKEN=ghp_...
#   ANTHROPIC_API_KEY=sk-ant-...

# 2. Build and start
docker compose up --build

# 3. Verify
curl http://localhost:3847/health
# {"ok":true}

curl http://localhost:3847/status
# {"activeRuns":0,"dailyCost":0,"paused":false,...}
```

## Creating a Test Issue

Go to your repo on GitHub and create an issue:

- **Title:** `Add /hello endpoint to control server`
- **Body:**
  ```
  Add a GET /hello endpoint to the HTTP control server that returns:
  {"message": "hello from auto-claude"}

  Specs: STACK-AC-CONTROL-PLANE

  Acceptance criteria:
  - GET /hello returns HTTP 200
  - Response body is JSON with a "message" field
  ```
- **Label:** `ready`

The daemon will:
1. Detect the issue (polls every 30s by default)
2. Claim it (swap label to `in-progress`)
3. Create a feature branch
4. Spawn a Claude worker session to implement it
5. Run deterministic checks (vitest, tsc)
6. Post a report comment and close the issue

## Operator Commands

```bash
# Check status
curl http://localhost:3847/status

# Pause (stops claiming new work, active runs finish)
curl -X POST http://localhost:3847/pause

# Resume
curl -X POST http://localhost:3847/resume

# Retry a stuck issue
curl -X POST http://localhost:3847/retry/42

# Health check
curl http://localhost:3847/health
```

Or via the CLI (when running locally):
```bash
pnpm start -- status -p 3847
pnpm start -- pause -p 3847
pnpm start -- resume -p 3847
pnpm start -- retry 42 -p 3847
```

## Configuration

See `auto-claude.config.example.json` for all options. Key settings:

| Field | Default | Description |
|-------|---------|-------------|
| `repo.owner` | — | GitHub repo owner (required) |
| `repo.name` | — | GitHub repo name (required) |
| `controlPort` | 3847 | HTTP control API port |
| `pollIntervalMs` | 30000 | How often to check for new issues (ms) |
| `maxConcurrentRuns` | 1 | Max parallel work requests |
| `dailyBudget` | 50 | Daily spending limit (USD) |
| `perRunBudget` | 10 | Per-issue spending limit (USD) |
| `adapter` | cli | Execution substrate: `cli` or `sdk` |
| `branches.staging` | staging | Staging branch name |
| `branches.production` | main | Production branch name |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | Docker only | API key for Claude CLI in Docker |

When running locally with Claude Max subscription, `ANTHROPIC_API_KEY` is not needed — the CLI uses your authenticated session.

## Stopping

```bash
# Docker
docker compose down

# Local (sends SIGINT, daemon shuts down gracefully)
Ctrl+C
```

The daemon handles `SIGTERM` and `SIGINT` gracefully: stops accepting new work, waits for active runs to finish (up to 30s grace period), flushes state, and exits.
