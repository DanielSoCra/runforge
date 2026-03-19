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

## Docker Compose Changes

### `docker-compose.yml` (dev)

Build context changes from `.` to `./packages/daemon`. Volume mounts for `prompts/`, `fitness/`, and `auto-claude.config.json` remain at root paths and still resolve correctly.

```yaml
services:
  daemon:
    build:
      context: ./packages/daemon
      dockerfile: Dockerfile
    volumes:
      - ./prompts:/app/prompts:ro
      - ./fitness:/app/fitness:ro
      - ./auto-claude.config.json:/app/auto-claude.config.json:ro
      - daemon-state:/app/state
```

### `docker-compose.prod.yml` (production)

Two context updates:

```yaml
  dashboard:
    build:
      context: ./packages/dashboard   # was: ./dashboard
      dockerfile: Dockerfile

  daemon:
    build:
      context: ./packages/daemon      # was: implicit root
      dockerfile: Dockerfile
```

## Migration Path

All steps run in the `feature/dashboard` worktree. `git mv` is used throughout to preserve file history.

1. Create `packages/daemon/` and `packages/dashboard/` directories
2. `git mv` daemon files to `packages/daemon/`: `src/`, `Dockerfile`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `package.json`
3. `git mv dashboard/ packages/dashboard/`
4. Create new root `package.json` and `pnpm-workspace.yaml`
5. Update `packages/daemon/package.json` — set `name: "@auto-claude/daemon"`
6. Update `packages/dashboard/package.json` — set `name: "@auto-claude/dashboard"`
7. Delete `packages/dashboard/pnpm-lock.yaml` and `packages/dashboard/pnpm-workspace.yaml`
8. Update `docker-compose.yml` and `docker-compose.prod.yml` build contexts
9. Run `pnpm install` from root to generate unified lockfile
10. Run `pnpm test` — verify both packages pass
11. Commit: `chore: convert to pnpm monorepo`
12. Merge `feature/dashboard` to main

## What Does Not Change

- Daemon `src/` code — no source edits
- Dashboard `app/`, `actions/`, `components/` code — no source edits
- TypeScript path aliases (`@/lib/...`) — resolved from `packages/dashboard/tsconfig.json`, unchanged
- Daemon `Dockerfile` internals — `COPY . .` copies from the package context, so `src/`, `package.json`, `pnpm-lock.yaml` are still found correctly
- `docker-compose.yml` volume mounts for `prompts/` and `fitness/`
