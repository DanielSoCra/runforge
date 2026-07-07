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
- `packages/dashboard/lib/daemon-fetch.ts` — the intended choke-point client; injects `X-Requested-By: dashboard`; no bearer logic. Only `app/api/daemon/halt/route.ts` forwards the bearer, ad hoc.
- **daemonFetch is NOT the only caller.** Direct control-plane callers that must not break: `packages/dashboard/app/(dashboard)/page.tsx:24` (direct `fetch(${DAEMON_URL}/status)`), `packages/briefing-summarizer/src/signals.ts:99` (`GET /status`), `packages/concierge/src/observer/daemon-poll.ts:45` (`GET /status`), and the daemon CLI itself — `packages/daemon/src/main.ts` `callApi()` (:139) hits `http://127.0.0.1:<port>` for `GET /status`, `GET /health`, `POST /pause|/resume|/retry/:issue` with only `X-Requested-By: cli`.
- **A second server exists:** `packages/daemon/src/control-plane/degraded-server.ts:36-43` serves unauthenticated `GET /health` and `GET /status` during degraded startup; it is started with the same resolved host (`daemon.ts:672-678`). The effective bind host is resolved at `daemon.ts:604-607` (`DAEMON_HOST ?? config.controlHost ?? default`) and **rejected unless `isIP(host) === 4`** (`daemon.ts:608-612`) — the daemon has an IPv4-only host contract; `localhost`/`::1` are already invalid values today.
- `scripts/install-daemon.sh` — seds `GITHUB_TOKEN`, `RUNFORGE_DATABASE_URL`, `ENCRYPTION_KEY` into the launchd plist (0600); does not provision `RUNFORGE_CONTROL_TOKEN`.
- `scripts/sync-claude-creds.sh` — creds file itself is 0600+atomic (fine); validation log goes to world-readable `/tmp/sync-claude-creds.validate`.
- Root `package.json` / `pnpm-workspace.yaml` — no overrides mechanism at all. `next@16.2.0` in `packages/dashboard`.
- `.github/workflows/ci.yml` — guard + lint/typecheck/test/flake-probe/e2e/build. No audit, no gitleaks. A `.gitleaks.toml` exists and `gitleaks detect --redact` passes locally today.

## Chosen Design (codex pick: "A+", 2 rounds)

### D1. Daemon-side bearer auth on the control plane

- **Token:** `RUNFORGE_CONTROL_TOKEN` (existing var, widened role — no new var).
- **Shared module:** implement the auth pieces once in a new `packages/daemon/src/control-plane/control-auth.ts` — `assertBindAllowed(host, token)` (startup gate) and `isAuthorized(req, token)` (request check) — consumed by **both** `server.ts` (`createControlServer`) and `degraded-server.ts`. The degraded server must not remain an unauthenticated bypass: its `/status` follows the same rule; `/health` stays exempt.
- **Startup gate (bind-host based, not per-request):** the daemon's IPv4-only host contract stands (`isIP(host) === 4`, `daemon.ts:608-612`); loopback therefore means an IPv4 `127.0.0.0/8` address (in practice `127.0.0.1`). If the effective bind host is non-loopback and the token is unset/empty → **refuse to start** with an actionable error. Enforced where the host is resolved (`daemon.ts:604-612`) before either server starts, and re-asserted inside `createControlServer`/`createDegradedServer` via `assertBindAllowed` (defense in depth — tests and other callers construct these servers directly). Docker's internal bridge is non-loopback and gets no exemption: "internal app network" is not an auth boundary.
- **Legacy loopback mode:** loopback bind + no token → start, but emit a loud startup warning and a per-request warning (rate-limited) that unauthenticated control-plane access is deprecated. This prevents bricking existing native installs whose dashboard doesn't yet send the bearer.
- **Request rule (token configured):** every route **except `GET /health`** requires `Authorization: Bearer <token>`. Full inventory (keep the "everything except /health" rule authoritative; this list is for the test matrix): mutating POST — `/pause`, `/halt`, `/resume`, `/drain`, `/drain/cancel`, `/repos/reload`, `/remote-control/restart`, `/issues/scan`, `/release`, `/release/preview`, `/release/completion`, `/ideas`, `/po/interactive-session`, `/decisions/:id/answer`, `/decisions/:id/reveal`, `/deployments/:id/widen`, `/retry/:id`; mutating PUT — `/spend/pricing-reference`; sensitive GET — `/status`, `/dashboard`, `/api/runs`, `/decisions/pending`, `/decisions/:id`, `/metrics/escalation`, `/spend/*`; degraded-server GET `/status`. Read exposure of decisions/spend/run metadata to co-resident containers is in scope. `GET /health` never requires auth (compose healthcheck/liveness) on either server.
- **`/halt` semantics preserved:** in legacy loopback mode `/halt` stays token-optional (the deliberate safe-stop escape hatch). Once a token is configured, `/halt` requires it like everything else. The non-loopback+no-token case no longer exists (refuse-to-start).
- **Mechanics:** shared `isAuthorized(req)` check before route dispatch and before body reads. Normalize the `Authorization` header to a single string; require exact `Bearer <token>` scheme; compare byte lengths first, then `crypto.timingSafeEqual` (it throws on length mismatch). 401 when header missing, 403 when invalid.
- **`X-Requested-By` is kept** for mutating methods as CSRF/provenance defense, demoted from "the auth" to defense-in-depth. Bearer check runs first.
- **Audit-log actor fallback** (`server.ts:555-562`) unchanged.

### D2. Clients — every control-plane caller sends the bearer

- **daemonFetch** injects `Authorization: Bearer $RUNFORGE_CONTROL_TOKEN` on **all** requests (GET included) when the env var is set; the header is set after caller headers so it cannot be overridden. Remove the ad-hoc bearer logic from `app/api/daemon/halt/route.ts`.
- **`app/(dashboard)/page.tsx`**: replace the direct `fetch(${DAEMON_URL}/status)` with `daemonFetch('/status', …)` so it inherits the bearer (keep its existing error handling for `DaemonConfigError`).
- **briefing-summarizer** (`src/signals.ts:99`) and **concierge** — ALL of its daemon call sites: `src/observer/daemon-poll.ts:45`, `src/tools/ac.ts:18-38` (`GET /status`, `POST /pause`, `POST /retry` — live via `src/core/runtime.ts:279-286`), `src/core/process-clients.ts:99-102` (`GET /status`): add the bearer header from `process.env.RUNFORGE_CONTROL_TOKEN` when set. Update the tests asserting the unauthenticated shape (`src/tools/ac.test.ts:34-39`, `src/core/process-clients.test.ts:88-103`).
- **daemon CLI** (`main.ts` `callApi`, and the second tested implementation in `control-plane/cli.ts:62-66` — update both or delete the stale one if truly unused, with its test): send the bearer from `process.env.RUNFORGE_CONTROL_TOKEN`; if unset, fall back to reading `RUNFORGE_CONTROL_TOKEN` from the repo-root `.env.mac` when the file exists (the operator's interactive shell won't have the launchd plist env). `/health` keeps working tokenless either way.
- **Built-in HTML dashboard** (`control-plane/dashboard.ts:128-135` does browser-side unauthenticated relative fetches to `/status`/`/api/runs`; served at `server.ts:103-106`): declared **legacy/loopback-only**. It keeps working when no token is configured (legacy loopback mode); in token mode its endpoints require the bearer like everything else, so the browser page becomes non-functional by design — the Next.js dashboard is the real UI. Document this in the spec/docs; removal of the built-in page is a follow-up. No token-in-query-string or cookie scheme is added for it.
- No module-load/startup hard failure in Next (breaks builds/tests/serverless). **Error-mapping owner: `daemonFetch`** — when the daemon returns 401/403, throw a typed `DaemonAuthError` ("control token missing or invalid — set RUNFORGE_CONTROL_TOKEN in the dashboard environment") alongside the existing `DaemonConfigError`; the proxy routes (which today return daemon responses verbatim, e.g. `app/api/daemon/status/route.ts:17-30`) catch it and return a 500-family JSON with that actionable message. Tested at the daemonFetch level plus one proxy route.

### D3. Deployment plumbing

- **docker-compose.yml:** every service that calls the daemon — daemon (containerized-daemon profile), dashboard, briefing-summarizer, and concierge if composed — gets `RUNFORGE_CONTROL_TOKEN: ${RUNFORGE_CONTROL_TOKEN:?set RUNFORGE_CONTROL_TOKEN in the selected env file}`, following the established `RUNFORGE_DOCKER_DATABASE_URL:?` pattern (services already use `env_file: ${ENV_FILE:-.env.prod}` for delivery; the `${…:?}` interpolation reads the shell/`--env-file`, not `env_file:` — same invocation contract as today, document it in `.env.prod.example`).
- **install-daemon.sh:** generate a token if absent (`openssl rand -hex 32`), persist it into `.env.mac` (0600), inject into the plist like the other vars. `.env.mac` is the local SSOT; the dashboard/summarizer containers on the same host consume it by launching compose with **both** mechanisms set — `ENV_FILE=.env.mac docker compose --env-file .env.mac …` (`--env-file` feeds the `${…:?}` interpolation; the `ENV_FILE` shell var feeds each service's `env_file:` — one alone is NOT sufficient, see `docker-compose.yml:64-69`). Document this exact invocation in `docs/running.md`/`.env.prod.example`. Rotation = update env source, reinstall/reload daemon, restart dashboard (documented).
- **com.runforge.daemon.plist:** add the `RUNFORGE_CONTROL_TOKEN` placeholder.
- **Env examples/docs:** `.env.mac.example`, `.env.prod.example`, `docs/running.md` updated.

### D4. Dependency hygiene

- Add overrides in the **root `package.json` nested field `"pnpm": { "overrides": { … } }`** (pnpm@10; NOT a top-level `overrides` key, NOT `pnpm-workspace.yaml`) with **minimal, exact pins** for the vulnerable transitive packages (path-to-regexp, picomatch, fast-uri, undici, vite, hono, …) and upgrade direct deps (`next` within v16) until **`pnpm audit --prod --audit-level high` exits 0**. Exact versions are resolved at implementation time from the registry — the plan does not invent version numbers. Comment each override with its advisory ID. If a "prod" finding is actually dev-graph noise (better-auth's peer graph attaching vitest/jsdom), fix classification/upgrade rather than blanket-override.
- **CI:** new `security` job — `pnpm audit --prod --audit-level high` (gate: exit 0, no allowlist) + full-history `gitleaks detect --redact` (no baseline; repo is currently clean). **Constraint from `scripts/check-ci-workflows.mjs:9-13,104-115`:** the guard forbids job-level `services:`, `container:`, and `uses: docker://…` — install gitleaks as a plain shell step (download the release binary, or `docker run` in a shell step like the existing Postgres pattern at `ci.yml:66-87`); never a Docker action/service container. Full-history catches committed-then-removed secrets; revisit commit-range scanning only if runtime hurts.

### D5. Secrets fix

- `sync-claude-creds.sh`: write the validation log to a 0600 file inside the creds dir (or a `mktemp` 0600 path), never world-readable `/tmp`.

### D6. Spec/traceability alignment (required by repo governance)

- Extend `STACK-AC-OPERATOR-AUTH` (and its ARCH/FUNC parents where behavior is described) to own the daemon control-plane auth: bearer requirement, bind-host startup gate, legacy loopback mode, `/health` exemption, `X-Requested-By` demotion.
- `.specify/traceability.yml`: add `server.ts`, `degraded-server.ts`, `control-auth.ts`, `daemon-fetch.ts`, compose/installer files under the operator-auth spec's `code_paths`; add `server.test.ts` (and the new auth test files) to `test_paths`.

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

- **`control-auth.test.ts` (new, unit):** `assertBindAllowed` matrix — {127.0.0.1, 0.0.0.0, other IPv4} × {token set, unset} → {ok, ok-with-warning, throw}; `isAuthorized` — valid token, wrong token same length, wrong token different length (no throw — byte-length check before `timingSafeEqual`), missing header (401), wrong scheme (403).
- **`server.test.ts`:** request-level matrix with the server constructed directly (as today, `server.test.ts:61-67`): {token set, unset} × {mutating route, sensitive GET, `/health`, `/halt`} → {2xx, 401, 403}. **Env hygiene:** save/restore `RUNFORGE_CONTROL_TOKEN` per test following the existing pattern in `phase0-halt.gate.test.ts:15,102-104` — the current `afterEach` only closes the server. **Existing-test fallout:** `server.test.ts:499-504` asserts `createControlServer(..., '0.0.0.0')` succeeds with no token — rewrite it to set a token (and add the fail-closed assertion for the tokenless case).
- **Degraded server:** `/status` requires bearer when token set; `/health` open — in its own test file or `daemon.test.ts` (the startup-gate/host-resolution behavior lives at daemon level, not in `server.test.ts`, which never exercises host resolution).
- **`daemon-fetch` tests:** bearer present on GET+POST when env set; absent when unset; caller cannot override the header. Halt proxy route test updated (bearer now via daemonFetch).
- **Client call sites:** briefing-summarizer/concierge/CLI — bearer attached when env set (unit-level where tests exist).
- Shell: installer idempotence (token generated once, reused on re-run) — grep-able acceptance checks at minimum.
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
5. Remove the built-in HTML dashboard (`control-plane/dashboard.ts`) or give it a proper auth story; it is legacy/loopback-only as of this change.

## Open Questions for Operator

- None blocking. Config-policy change (follow-up 3) is an Operator release-policy decision by design.
