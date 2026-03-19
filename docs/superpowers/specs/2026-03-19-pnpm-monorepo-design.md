# pnpm Monorepo Conversion — Design

**Date:** 2026-03-19
**Status:** Approved

## Goal

Convert the auto-claude repo from a single root package to a pnpm monorepo with two workspace packages: `@auto-claude/daemon` and `@auto-claude/dashboard`. Work is done entirely within the `feature/dashboard` worktree so both packages land in a single merge to main.

## Directory Structure

```
auto-claude/
├── pnpm-workspace.yaml          # packages: ['packages/*']
├── package.json                 # workspace root — scripts only, no deps
├── CLAUDE.md, AGENTS.md
├── docs/, .specify/, infra/     # cross-cutting, stay at root
├── prompts/, fitness/           # daemon docker volume mounts — stay at root
├── auto-claude.config.json      # user config — stays at root
├── docker-compose.yml           # dev compose — updated build context
├── docker-compose.prod.yml      # prod compose — updated build contexts
├── Caddyfile
└── packages/
    ├── daemon/
    │   ├── src/
    │   ├── package.json         # name: "@auto-claude/daemon"
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   ├── eslint.config.js
    │   └── Dockerfile
    └── dashboard/
        ├── app/, actions/, components/, lib/
        ├── package.json         # name: "@auto-claude/dashboard"
        └── Dockerfile
```

`prompts/` and `fitness/` stay at the repo root because they are Docker volume-mounted at runtime, not package dependencies.

## Root `package.json`

```json
{
  "name": "auto-claude",
  "version": "1.0.0",
  "private": true,
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "dev:dashboard": "pnpm --filter @auto-claude/dashboard dev",
    "test": "pnpm -r test",
    "test:daemon": "pnpm --filter @auto-claude/daemon test",
    "test:dashboard": "pnpm --filter @auto-claude/dashboard test",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck"
  }
}
```

## `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'

ignoredBuiltDependencies:
  - sharp
  - unrs-resolver
```

The `ignoredBuiltDependencies` entries were previously in `dashboard/pnpm-workspace.yaml`; they move here. The dashboard's `pnpm-lock.yaml` and `pnpm-workspace.yaml` are deleted — one root lockfile covers both packages.

## Docker Build Context

**Critical constraint:** After monorepo conversion, `pnpm-lock.yaml` lives at the repo root. Docker `COPY` cannot reach outside the build context, so **both packages must use `context: .` (repo root)** with an explicit `dockerfile:` path pointing into `packages/`.

Both Dockerfiles use selective COPY that works from the repo root context:

1. Copy workspace root files (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`)
2. Copy **both** package manifests — pnpm needs all workspace package.json files to resolve the unified lockfile
3. Run `pnpm install --frozen-lockfile`
4. Copy only the relevant package's source

### Daemon Dockerfile (`packages/daemon/Dockerfile`)

The daemon uses `process.cwd()` to resolve `state/`, `prompts/`, `fitness/`, and `auto-claude.config.json`. Setting `WORKDIR /app/packages/daemon` makes those relative paths resolve correctly, and volume mounts in the compose files target that same path.

```dockerfile
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

# Install phase — repo root as context, so pnpm-lock.yaml is accessible
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
RUN pnpm install --frozen-lockfile

# Copy daemon source
COPY packages/daemon/src/ ./packages/daemon/src/
COPY packages/daemon/tsconfig.json ./packages/daemon/

# Run from daemon package dir so process.cwd() resolves state/, prompts/, etc.
WORKDIR /app/packages/daemon
RUN mkdir -p state/runs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://127.0.0.1:3847/health || exit 1

EXPOSE 3847

# CMD (not ENTRYPOINT) so docker-compose `command:` can fully override it in dev
CMD ["pnpm", "start", "--", "-c", "/app/packages/daemon/auto-claude.config.json"]
```

### Dashboard Dockerfile (`packages/dashboard/Dockerfile`)

```dockerfile
FROM node:22-alpine AS base
RUN npm install -g pnpm

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
# Workspace root files are required so pnpm recognises the workspace and
# resolves node_modules from /app/node_modules during next build
COPY package.json pnpm-workspace.yaml ./
COPY packages/daemon/package.json ./packages/daemon/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY packages/dashboard/ ./packages/dashboard/
WORKDIR /app/packages/dashboard
RUN pnpm build

FROM base AS runner
WORKDIR /app/packages/dashboard
ENV NODE_ENV=production
COPY --from=builder /app/packages/dashboard/.next/standalone ./
COPY --from=builder /app/packages/dashboard/.next/static ./.next/static
COPY --from=builder /app/packages/dashboard/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

## Docker Compose Changes

### `docker-compose.yml` (dev)

Context changes to `.` (repo root) with explicit dockerfile path. Volume mounts updated to bind into `/app/packages/daemon/` to match the daemon's `WORKDIR`. Config path in the `command:` override is also updated.

```yaml
services:
  daemon:
    build:
      context: .
      dockerfile: packages/daemon/Dockerfile
    volumes:
      - ./prompts:/app/packages/daemon/prompts:ro
      - ./fitness:/app/packages/daemon/fitness:ro
      - ./auto-claude.config.json:/app/packages/daemon/auto-claude.config.json:ro
      - daemon-state:/app/packages/daemon/state
    command: >
      sh -c "
        git config --global user.name 'Auto-Claude' &&
        git config --global user.email 'auto-claude@localhost' &&
        pnpm start -- -c /app/packages/daemon/auto-claude.config.json
      "
```

### `docker-compose.prod.yml` (production)

Two context updates. Also fixes the `dockerfile: Dockerfile.daemon` reference (that file does not exist — the root `Dockerfile` is the daemon's Dockerfile, and it moves to `packages/daemon/Dockerfile`). Daemon volume mounts are added (they were missing from the prod compose).

```yaml
  dashboard:
    build:
      context: .
      dockerfile: packages/dashboard/Dockerfile   # was: context ./dashboard, dockerfile Dockerfile

  daemon:
    build:
      context: .
      dockerfile: packages/daemon/Dockerfile      # was: Dockerfile.daemon (non-existent)
    volumes:
      - ./prompts:/app/packages/daemon/prompts:ro
      - ./fitness:/app/packages/daemon/fitness:ro
      - ./auto-claude.config.json:/app/packages/daemon/auto-claude.config.json:ro
      - daemon-state:/app/packages/daemon/state
```

## `traceability.yml` Path Updates

After `git mv`, all `code_paths` and `test_paths` entries referencing `src/` (daemon) or `dashboard/` must be updated:

- `src/` → `packages/daemon/src/`
- `dashboard/` → `packages/dashboard/`

This applies to `STACK-AC-DAEMON` and `STACK-AC-DASHBOARD` entries.

## Migration Path

All steps run in the `feature/dashboard` worktree. `git mv` is used throughout to preserve file history.

1. Create `packages/daemon/` and `packages/dashboard/` directories
2. `git mv` daemon files to `packages/daemon/`: `src/`, `Dockerfile`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `package.json`
3. `git mv dashboard/ packages/dashboard/`
4. Create new root `package.json` and `pnpm-workspace.yaml`
5. Update `packages/daemon/package.json` — set `name: "@auto-claude/daemon"`
6. Update `packages/dashboard/package.json` — set `name: "@auto-claude/dashboard"`
7. Delete `packages/dashboard/pnpm-lock.yaml` and `packages/dashboard/pnpm-workspace.yaml`
8. Rewrite `packages/daemon/Dockerfile` — use repo-root context pattern with dual `WORKDIR` (see Daemon Dockerfile section)
9. Rewrite `packages/dashboard/Dockerfile` — use repo-root context pattern (see Dashboard Dockerfile section)
10. Update `docker-compose.yml` — new build context, dockerfile path, volume mounts, and command (see docker-compose.yml section)
11. Update `docker-compose.prod.yml` — new contexts, dockerfile paths, add daemon volumes, fix Dockerfile.daemon reference (see docker-compose.prod.yml section)
12. Update `.specify/traceability.yml` — update `code_paths` and `test_paths` for daemon and dashboard specs
13. Run `pnpm install` from root to generate unified lockfile
14. Run `pnpm test` — verify both packages pass
15. Commit: `chore: convert to pnpm monorepo`
16. Merge `feature/dashboard` to main

## What Does Not Change

- Daemon `src/` code — no source edits
- Dashboard `app/`, `actions/`, `components/` code — no source edits
- TypeScript path aliases (`@/lib/...`) — resolved from `packages/dashboard/tsconfig.json`, unchanged
- Root `.gitignore` — `node_modules/` (no leading slash) already matches `packages/*/node_modules/` in git; no change needed
