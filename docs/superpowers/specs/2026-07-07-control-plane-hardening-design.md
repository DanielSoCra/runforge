# Control-Plane Hardening — Design Spec

Date: 2026-07-07 · Status: draft → codex-reviewed · Author: Claude (sparring-driven-development)

## Goal

Address the production-readiness findings from the 2026-07-07 external engineering review in one focused hardening PR:

1. **Auth boundary:** the daemon control plane guards mutating routes with a presence-only `X-Requested-By` header; only `/halt` optionally checks a bearer token. Sensitive actions (`/resume`, `/decisions/:id/reveal`, `/remote-control/restart`, `/release`, `/deployments/:id/widen`, `/retry/:id`, `PUT /spend/pricing-reference`) are effectively unauthenticated inside the network boundary.
2. **Dependency hygiene:** `pnpm audit --prod` reports 68 vulnerabilities (20 high). No `pnpm.overrides` exist; CI has no audit or secret-scan job.
3. **Secrets handling:** `sync-claude-creds.sh` writes a validation log to world-readable `/tmp`; the launchd installer does not provision a control token at all.
4. **Spec coverage gap:** `FUNC/ARCH/STACK-AC-OPERATOR-AUTH` do not own the daemon-side control-plane auth model (`server.ts` is traced only under `STACK-AC-RUNTIME-SOURCE-ISOLATION`).

**Explicitly out of scope (filed as follow-up issues, not built here):** decomposing `server.ts` (790 lines) and `daemon.ts` (4,271 lines); changing `runforge.config.json` pipeline policy (`gate1Commands`, `baselinePreexistingFailures`). Rationale (codex round 1): refactors dilute a security diff on a RED-risk path; config flags are live release-policy changes, not honesty edits.

## Current State (verified 2026-07-07)

- `packages/daemon/src/control-plane/server.ts:94-101` — POST/PUT without `x-requested-by` → 403. Value never validated. GETs unguarded.
- `server.ts:147-177` — `/halt` requires `Authorization: Bearer $RUNFORGE_CONTROL_TOKEN` **only if** the env var is set; unset → reachable with CSRF header alone ("fail-safe toward halting").
- `server.ts:552-554` — comment: daemon is not role-aware; dashboard enforces admin-only.
- Bind: `createControlServer(port, handlers, host='127.0.0.1')` (`server.ts:85-89`); Docker sets `DAEMON_HOST=0.0.0.0` on the internal `app` network, `ports: []` (nothing published). Compose sets **no** `RUNFORGE_CONTROL_TOKEN`.
- `packages/dashboard/lib/daemon-fetch.ts` — single choke-point client; injects `X-Requested-By: dashboard`; no bearer logic. Only `app/api/daemon/halt/route.ts` forwards the bearer, ad hoc.
- `scripts/install-daemon.sh` — seds `GITHUB_TOKEN`, `RUNFORGE_DATABASE_URL`, `ENCRYPTION_KEY` into the launchd plist (0600); does not provision `RUNFORGE_CONTROL_TOKEN`.
- `scripts/sync-claude-creds.sh` — creds file itself is 0600+atomic (fine); validation log goes to world-readable `/tmp/sync-claude-creds.validate`.
- Root `package.json` / `pnpm-workspace.yaml` — no overrides mechanism at all. `next@16.2.0` in `packages/dashboard`.
- `.github/workflows/ci.yml` — guard + lint/typecheck/test/flake-probe/e2e/build. No audit, no gitleaks. A `.gitleaks.toml` exists and `gitleaks detect --redact` passes locally today.

## Chosen Design (codex pick: "A+", 2 rounds)

### D1. Daemon-side bearer auth on the control plane

- **Token:** `RUNFORGE_CONTROL_TOKEN` (existing var, widened role — no new var).
- **Startup gate (bind-host based, not per-request):** if the effective bind host is non-loopback (`0.0.0.0`, `::`, or any non-`127.0.0.1`/`::1`/`localhost` value) and the token is unset/empty → **refuse to start** with an actionable error. Docker's internal bridge is non-loopback and gets no exemption: "internal app network" is not an auth boundary.
- **Legacy loopback mode:** loopback bind + no token → start, but emit a loud startup warning and a per-request warning (rate-limited) that unauthenticated control-plane access is deprecated. This prevents bricking existing native installs whose dashboard doesn't yet send the bearer.
- **Request rule (token configured):** every route **except `GET /health`** requires `Authorization: Bearer <token>` — mutating POST/PUT *and* sensitive GETs (`/status`, `/dashboard`, `/api/runs`, `/decisions/*`, `/spend/*`, `/metrics/*`). Read exposure of decisions/spend/run metadata to co-resident containers is in scope. `GET /health` never requires auth (compose healthcheck/liveness).
- **`/halt` semantics preserved:** in legacy loopback mode `/halt` stays token-optional (the deliberate safe-stop escape hatch). Once a token is configured, `/halt` requires it like everything else. The non-loopback+no-token case no longer exists (refuse-to-start).
- **Mechanics:** shared `isAuthorized(req)` check before route dispatch and before body reads. Normalize the `Authorization` header to a single string; require exact `Bearer <token>` scheme; compare byte lengths first, then `crypto.timingSafeEqual` (it throws on length mismatch). 401 when header missing, 403 when invalid.
- **`X-Requested-By` is kept** for mutating methods as CSRF/provenance defense, demoted from "the auth" to defense-in-depth. Bearer check runs first.
- **Audit-log actor fallback** (`server.ts:555-562`) unchanged.

### D2. Dashboard client

- `daemonFetch` injects `Authorization: Bearer $RUNFORGE_CONTROL_TOKEN` on **all** requests (GET included) when the env var is set; the header is set after caller headers so it cannot be overridden. Remove the ad-hoc bearer logic from `app/api/daemon/halt/route.ts`.
- No module-load/startup hard failure in Next (breaks builds/tests/serverless): missing token when the daemon rejects → surface per-request as a clear error (extend the existing `DaemonConfigError` pattern, e.g. map daemon 401/403 to an actionable message).

### D3. Deployment plumbing

- **docker-compose.yml:** daemon + dashboard services get `RUNFORGE_CONTROL_TOKEN: ${RUNFORGE_CONTROL_TOKEN:?set RUNFORGE_CONTROL_TOKEN in the selected env file}`. Note `${...}` interpolation reads the shell/project `--env-file`, not `env_file:` — document in `.env.prod.example`.
- **install-daemon.sh:** generate a token if absent (`openssl rand -hex 32`), persist it into `.env.mac` (0600), inject into the plist like the other vars. `.env.mac` is the local SSOT the dashboard shares. Rotation = update env source, reinstall/reload daemon, restart dashboard (documented).
- **com.runforge.daemon.plist:** add the `RUNFORGE_CONTROL_TOKEN` placeholder.
- **Env examples/docs:** `.env.mac.example`, `.env.prod.example`, `docs/running.md` updated.

### D4. Dependency hygiene

- Add root `pnpm.overrides` with **minimal, exact pins** for the vulnerable transitive packages (path-to-regexp, picomatch, fast-uri, undici, vite, hono, …) and upgrade direct deps (`next` within v16) until **`pnpm audit --prod --audit-level high` exits 0**. Exact versions are resolved at implementation time from the registry — the plan does not invent version numbers. If a "prod" finding is actually dev-graph noise (better-auth's peer graph attaching vitest/jsdom), fix classification/upgrade rather than blanket-override.
- **CI:** new `security` job — `pnpm audit --prod --audit-level high` (gate: exit 0, no allowlist) + full-history `gitleaks detect --redact` (no baseline; repo is currently clean). Full-history catches committed-then-removed secrets; revisit commit-range scanning only if runtime hurts.

### D5. Secrets fix

- `sync-claude-creds.sh`: write the validation log to a 0600 file inside the creds dir (or a `mktemp` 0600 path), never world-readable `/tmp`.

### D6. Spec/traceability alignment (required by repo governance)

- Extend `STACK-AC-OPERATOR-AUTH` (and its ARCH/FUNC parents where behavior is described) to own the daemon control-plane auth: bearer requirement, bind-host startup gate, legacy loopback mode, `/health` exemption, `X-Requested-By` demotion.
- `.specify/traceability.yml`: add `server.ts`, `daemon-fetch.ts`, compose/installer files under the operator-auth spec's `code_paths`; add `server.test.ts` to `test_paths`.

## Rejected Alternatives

- **B (bundle server.ts split):** dilutes the security diff on a RED-risk path; do after auth tests lock behavior. → follow-up issue.
- **C (split daemon.ts):** ~3,585-line `startDaemon()`; high regression risk, weeks of work. → follow-up issue.
- **D (bundle config-policy cleanup):** `gate1Commands`/`baselinePreexistingFailures` alter the live pipeline's operating contract — release-policy decisions for the Operator, not hardening. → follow-up issue tagged for Operator decision.
- **Per-request remote-address gating:** proxies/docker NAT make remote addresses unreliable; bind-host at startup is deterministic.
- **mTLS / dashboard-role-aware daemon:** overkill for a single-operator control plane; bearer + network isolation + dashboard RBAC is proportionate.

## Backward Compatibility / Rollout

| Deployment | Before | After upgrade |
|---|---|---|
| Native (loopback, no token) | works, unauthenticated | works, loud deprecation warnings; installer provisions token on next `install-daemon.sh` run |
| Docker (0.0.0.0, no token) | works, unauthenticated | compose interpolation fails fast with actionable message until token set in env file — **deliberate fail-closed**; documented in PR body + `.env.prod.example` |
| Docker (token set) | only /halt guarded | all routes guarded end-to-end |

## Test Strategy

- `server.test.ts`: matrix — {loopback, non-loopback} × {token set, unset} × {mutating, sensitive GET, /health, /halt} → expected {200-family, 401, 403, refuse-to-start}. Timing-safe compare: wrong token same length / different length both → 403, no throw.
- `daemon-fetch` tests: bearer present on GET+POST when env set; absent when unset; caller cannot override the header.
- Halt proxy route test updated (bearer now via daemonFetch).
- Shell: installer idempotence (token generated once, reused on re-run) — assert via bats-style or a plan-level manual check; at minimum grep-able acceptance checks.
- CI security job proves itself on the PR run (audit exit 0, gitleaks clean).

## Risks

- **Upgrade friction (docker):** intentional fail-fast; mitigation = clear compose error text + docs.
- **Override pins drift:** overrides can mask future legit upgrades; mitigation = comment each override with the advisory ID.
- **better-auth prod-audit noise:** may require upstream upgrade instead of override; time-boxed — if a high advisory is unfixable without breaking better-auth, document as accepted-risk in the PR (gate would then need that single advisory ignored via `pnpm audit` ignore mechanism, commented with expiry).
- **Legacy mode lingering forever:** follow-up issue includes removing legacy loopback mode after one release cycle.

## Follow-ups (filed as issues in Phase 8/9)

1. Extract `server.ts` routing/middleware/handlers (mechanical, after auth tests lock behavior).
2. Decompose `daemon.ts` `startDaemon()` into phase modules.
3. Operator decision: `gate1Commands` widening + `baselinePreexistingFailures:false`.
4. Remove legacy loopback unauthenticated mode after one release cycle.

## Open Questions for Operator

- None blocking. Config-policy change (follow-up 3) is an Operator release-policy decision by design.
