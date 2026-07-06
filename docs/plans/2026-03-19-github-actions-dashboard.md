> **🗄 HISTORICAL (2026-06-02).** Completed/superseded record, kept for provenance — superseded by the unified **L0-AC-VISION v5** (`.specify/L0-ac-vision.md`) + its L1 children. The canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Plan: GitHub Actions Trigger, process-single, and Dashboard

**Date:** 2026-03-19

## What Was Built

- **`src/control-plane/process-single.ts`** — One-shot issue processor for GitHub Actions use. Loads config, fetches a single issue, claims it, runs the full pipeline, then exits. Used by the `process <issue>` CLI command.

- **`src/control-plane/dashboard.ts`** — Self-contained HTML dashboard. Dark-themed (`#0d1117`), auto-refreshes every 5 seconds via `fetch` to `/status` and `/api/runs`. Uses safe DOM APIs only (no innerHTML).

- **`.github/workflows/runforge.yml`** — GitHub Actions workflow triggered on `issues.labeled` with the `ready` label. Runs on a self-hosted runner, sets up Node 22 + pnpm, installs deps, and calls `npx tsx src/main.ts process "$ISSUE_NUMBER" -c runforge.config.json`.

- **`src/main.ts`** (modified) — Replaced with Commander-based CLI that includes `start`, `process <issue>`, `status`, `pause`, `resume`, `retry <issue>`, and `health` commands.

- **`src/control-plane/server.ts`** (modified) — Added `GET /dashboard` and `GET /api/runs` routes. Added `stateDir?` to `ControlHandlers`.

- **`docs/hetzner-setup.md`** — Deployment guide for Hetzner Cloud with self-hosted runner setup, systemd services, and secrets configuration.

## Motivation

The GitHub Actions integration allows Runforge to be triggered on-demand by labeling an issue `ready`, without requiring the polling daemon to be running. This is useful for lower-volume repos or ephemeral CI environments. The dashboard provides visibility into running/completed work without requiring external tooling.
