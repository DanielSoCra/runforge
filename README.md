# Runforge

Runforge is a self-hosted control plane for autonomous, spec-driven software work. A long-running daemon polls GitHub issues, claims eligible work, creates isolated git worktrees, starts configured worker sessions, and drives each run through deterministic phases such as detect, classify, implement, review, integrate, release, and report.

The core idea is simple: reasoning models do the flexible work, while Runforge owns state, isolation, budgets, gates, and merge decisions.

## Mechanics

- **GitHub issues are the queue.** The daemon polls repositories and turns labeled issues into tracked runs.
- **Workers run in isolated worktrees.** Each implementation attempt gets its own branch and filesystem workspace.
- **The pipeline is fail-closed.** Missing verification, broken governance state, uncertain risk, or unavailable decision infrastructure holds the run instead of merging.
- **Lanes are declarative.** `runforge.config.json` defines repositories, branch targets, lane rules, gate sets, budgets, and merge behavior.
- **Lane matching is first-match-wins.** The first lane whose criteria match a run owns the role routing, verifier, scope, and merge policy for that run.
- **Risk only raises caution.** Green, yellow, orange, and red form a raise-only floor; sensitive paths, compliance findings, and always-escalate classes can move work to a more cautious path, never a less cautious one.
- **Verifiers are falsifiable oracles.** A lane must name checks that can really fail on the domain outcome before it can earn unattended merging.
- **Budgets are hard stops.** Per-run and daily spend caps, fix-cycle caps, and line-count caps bound autonomous work.
- **Merge decisions are governed.** The merge layer composes lane assignment, verifier status, touched paths, risk, compliance, earned autonomy, and human approvals before anything joins the shared branch.
- **Operator learning is bounded.** The system can learn when to ask less often, but it does not self-modify code or weaken gates.

## Human Gates

Runforge is autonomous below the boundaries the Operator reserves:

- L1 functional spec authoring and changes stay human-owned.
- Production release approval stays human-owned.
- Public release, repository rename, and deployment cutover stay human-owned.
- Force-pushes, destructive cleanup, and live infrastructure changes require explicit approval outside the normal pipeline.

## Limits

Runforge currently reflects one self-hosted deployment rather than a polished hosted product. Alerting is degraded compared with a production SaaS control plane. Promotion and daemon restarts are still manual. Some phases are no-ops unless configured for a deployment. Stuck runs need manual retry or operator intervention. Public-release readiness also requires a dedicated secret scan and repository cutover that this repo does not perform automatically.

## Repository Layout

- `packages/daemon` - polling, run state, worker orchestration, governance, merge decisions, and release control.
- `packages/dashboard` - operator UI for monitoring and controls.
- `packages/db` - database schema and persistence helpers.
- `packages/decision-*` - decision request protocol, index, and protected answer storage.
- `packages/release-ledger` - append-only release proposal, decision, and execution log.
- `.specify` - functional, architecture, and stack specs that govern implementation.
- `docs` - plans, runbooks, and operational notes.
- `scripts` - local checks, launchd helpers, and deployment utilities.

## Quick Start

```bash
pnpm install
cp .env.prod.example .env.prod
cp runforge.config.example.json runforge.config.json
pnpm --filter @runforge/daemon start
```

Fill in credentials and deployment-specific values before starting the daemon. See `docs/running.md` for setup, configuration, Docker, macOS hybrid, Hetzner, and operator commands.
