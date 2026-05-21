# Auto-Claude

An agent harness that turns a reasoning engine into a reliable, autonomous spec implementer.

Auto-Claude polls GitHub for work requests (issues with spec references), classifies complexity, spawns Claude workers, drives them through an FSM pipeline (implement, review, integrate, deploy), and reports results — all unattended.

## Architecture

- **daemon** (`packages/daemon`) — polls GitHub issues, manages pipeline state, spawns Claude workers
- **dashboard** (`packages/dashboard`) — Next.js web UI backed by app-owned Postgres and Better Auth for monitoring and operator controls
- **briefing-summarizer** (`packages/briefing-summarizer`) — generates periodic activity summaries

## Quick start

```bash
pnpm install
cp .env.prod.example .env.prod   # fill in credentials
cp auto-claude.config.example.json auto-claude.config.json

# Start the daemon
cd packages/daemon && pnpm start
```

See [docs/running.md](docs/running.md) for full setup, configuration, deployment options (Docker, Mac Mini hybrid, Hetzner), and operator commands.
