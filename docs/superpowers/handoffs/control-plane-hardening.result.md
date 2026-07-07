---
status: complete
pr: https://github.com/DanielSoCra/runforge/pull/1
branch: codex/control-plane-hardening-build
session: not available
verify_command_result: pass
---

## Done

- Implemented daemon control-plane bearer auth boundary (`control-auth.ts`, `server.ts`, `degraded-server.ts`, `daemon.ts` startup gate) with loopback legacy mode and `/health` exemption.
- Updated all clients to forward `RUNFORGE_CONTROL_TOKEN`: dashboard `daemonFetch` + proxy routes, briefing-summarizer, concierge, daemon CLI (`main.ts`/`cli.ts`).
- Added typed `DaemonAuthError` in dashboard and handled it in every `daemonFetch` caller.
- Completed deployment plumbing: compose token requirement, launchd installer token provisioning, plist placeholder, creds validation log permissions fix.
- Cleared high-severity prod audit findings via direct upgrades (`next` 16.2.10, `hono` 4.12.28, `better-auth` 1.6.23) and root `pnpm.overrides` pins for transitive packages.
- Added security steps inside the required `ci` job: `pnpm audit --prod --audit-level high` and full-history `gitleaks detect --redact` with pinned binary + sha256 verification.
- Updated `.specify` specs/traceability and created `docs/security-overrides.md`.
- Full gates green: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, `pnpm check:traceability && pnpm check:workflows`, `gitleaks detect --redact`, `pnpm audit --prod --audit-level high`.
- Acceptance tests pass via `pnpm --filter @runforge/daemon exec vitest run src/control-plane/__acceptance__`.
- Committed, pushed `codex/control-plane-hardening-build`, and opened PR #1 against `main`.

## Unverified / risks

- CI `Gitleaks (full history)` step will only prove itself on the actual GitHub Actions run; the local `gitleaks detect --redact` is clean.
- `better-auth` 1.6.23 moved `vitest` to a peer dependency, but `pnpm audit --prod` still reports its transitive dev-graph packages unless overridden; the overrides are in place and audit exits 0.
- Dependency override pins (`pnpm.overrides`) can drift over time; recorded in `docs/security-overrides.md` with advisory IDs and date.

## Dead ends

- Tried nested path overrides (`better-auth>vitest>picomatch`) — pnpm rejects selectors deeper than one parent-child level; switched to one-level overrides (`vitest>picomatch`, `jsdom>undici`, etc.) which pnpm accepts.
- Initially attempted to clear better-auth audit noise by upgrading alone; the package still resolves its peer dev graph into the audit report, so overrides were required for those transitive packages.
