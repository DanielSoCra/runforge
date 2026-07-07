# Control-Plane Hardening — Implementation Plan

Spec: `docs/superpowers/specs/2026-07-07-control-plane-hardening-design.md` (codex-reviewed CLEAN, 5 iterations). Read it first; it is authoritative on behavior. This plan sequences the work.

Branch: `codex/control-plane-hardening-build` (off this plan branch). All commands run from the repo root. Gate: acceptance tests in `packages/daemon/src/control-plane/__acceptance__/` (authored separately, immovable — do NOT modify them). They are plain Vitest files named `*.test.ts` so the daemon's default `vitest run` (root `src`, no custom include) picks them up.

## Task 0 — Baseline

```bash
pnpm install --frozen-lockfile
pnpm --filter @runforge/daemon test   # must pass before starting
```

## Task 1 — `.specify` spec + traceability updates

Files: `.specify/stack/operator-auth-ts.md` (STACK-AC-OPERATOR-AUTH), `.specify/architecture/operator-auth.md`, `.specify/functional/operator-auth.md`, `.specify/traceability.yml`.

- Extend `STACK-AC-OPERATOR-AUTH` with the daemon control-plane auth model: bearer `RUNFORGE_CONTROL_TOKEN` on every route except `GET /health` (both servers); bind-host startup gate (IPv4-only contract, loopback = `127.0.0.0/8`; non-loopback + no token = refuse to start); legacy loopback mode (loopback + no token = start with loud warnings, `/halt` token-optional); `X-Requested-By` demoted to CSRF/provenance defense on mutating methods; built-in HTML dashboard = legacy/loopback-only.
- Update ARCH/FUNC parents only where they describe the boundary ("role enforcement happens in the dashboard" must become "dashboard enforces roles; daemon enforces the bearer boundary").
- `traceability.yml`: under the operator-auth stack spec add `code_paths`: `packages/daemon/src/control-plane/server.ts`, `packages/daemon/src/control-plane/degraded-server.ts`, `packages/daemon/src/control-plane/control-auth.ts`, `packages/dashboard/lib/daemon-fetch.ts`, `docker-compose.yml`, `scripts/install-daemon.sh`, `scripts/com.runforge.daemon.plist`; `test_paths`: `packages/daemon/src/control-plane/control-auth.test.ts`, `packages/daemon/src/control-plane/server.test.ts`.
- Verify: `pnpm check:traceability` exits 0.

Commit: `spec(operator-auth): daemon control-plane bearer boundary + traceability`

## Task 2 — `control-auth.ts` (TDD)

New: `packages/daemon/src/control-plane/control-auth.ts` + `control-auth.test.ts`.

API:
```ts
export class ControlBindError extends Error {}
export function isLoopbackHost(host: string): boolean        // IPv4 127.0.0.0/8 only (host contract is isIP===4)
export function assertBindAllowed(host: string, token: string | undefined): void
  // non-loopback + (!token || token === '') → throw ControlBindError with actionable message
  // loopback + no token → return (caller logs the legacy-mode warning)
export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string }
export function checkAuthorization(authorizationHeader: string | string[] | undefined, token: string): AuthResult
  // missing header → 401; non-Bearer scheme or wrong value → 403
  // compare via Buffer byte-length check FIRST, then crypto.timingSafeEqual (it throws on length mismatch)
```

Tests (write first, red → green): loopback/non-loopback × token matrix for `assertBindAllowed`; `checkAuthorization` — valid; wrong same-length; wrong different-length (no throw); missing (401); `Basic` scheme (403); array header normalized.

Commit: `feat(daemon): control-plane auth primitives (bind gate + bearer check)`

## Task 3 — `server.ts` enforcement

File: `packages/daemon/src/control-plane/server.ts`.

- Read `RUNFORGE_CONTROL_TOKEN` once per request handling (keep current per-request `process.env` read semantics so tests can toggle it — mirror how `/halt` reads it today at :152).
- In the top-level request handler, BEFORE route dispatch and body reads: if token configured → `checkAuthorization(req.headers.authorization, token)`; on failure respond 401/403 JSON `{error}` for every path except `GET /health`. If token not configured (legacy loopback mode — non-loopback can't reach here, see Task 5) → allow, but log a rate-limited warning (at most once per minute) naming the deprecation.
- Keep the existing `X-Requested-By` presence check for POST/PUT (runs AFTER bearer).
- `/halt`: remove its ad-hoc token block (now covered globally); preserve its semantics — with no token configured it remains reachable with only the CSRF header.
- `createControlServer(port, handlers, host)`: call `assertBindAllowed(host, process.env.RUNFORGE_CONTROL_TOKEN)` before `listen` (defense in depth).
- Update `server.test.ts`: request matrix {token set, unset} × {mutating POST, sensitive GET (`/status`, `/decisions/pending`), `GET /health`, `/halt`} → {2xx/expected, 401 missing, 403 wrong}; env save/restore per `phase0-halt.gate.test.ts:15,102-104` pattern; REWRITE `server.test.ts:499-504` (currently asserts tokenless `0.0.0.0` succeeds) to set a token, and add a fail-closed assertion (`ControlBindError`) for the tokenless non-loopback case.

Commit: `feat(daemon): require bearer on control plane; fail closed off-loopback`

## Task 4 — `degraded-server.ts` enforcement

File: `packages/daemon/src/control-plane/degraded-server.ts` (+ its test file, or `degraded-server.test.ts` if none).

- Same rule via `checkAuthorization`: `/status` requires bearer when token set; `GET /health` always open. `assertBindAllowed` before listen.

Commit: `feat(daemon): degraded server honors control token`

## Task 5 — daemon startup gate

File: `packages/daemon/src/control-plane/daemon.ts` (host resolution ~:604-612, degraded server start ~:672-678).

- After resolving `daemonHost`, call `assertBindAllowed(daemonHost, process.env.RUNFORGE_CONTROL_TOKEN)`; surface `ControlBindError` as a fatal startup error with the actionable message (set token or bind loopback). When loopback + no token → log the legacy-mode startup warning (once).
- Test at daemon level (in `daemon.test.ts` or a focused new test): non-loopback + no token refuses startup; loopback + no token starts with warning.

Commit: `feat(daemon): refuse non-loopback bind without control token`

## Task 6 — dashboard client + proxy sweep

Files: `packages/dashboard/lib/daemon-fetch.ts`, `packages/dashboard/app/(dashboard)/page.tsx`, `packages/dashboard/app/api/daemon/halt/route.ts`, all `daemonFetch` callers.

- `daemonFetch`: when `process.env.RUNFORGE_CONTROL_TOKEN` set, set `Authorization: Bearer <token>` AFTER merging caller headers (caller cannot override). On daemon 401/403 throw new typed `DaemonAuthError` (message: control token missing or invalid — set `RUNFORGE_CONTROL_TOKEN` in the dashboard environment). Export it next to `DaemonConfigError`.
- `page.tsx:24`: replace direct `fetch(${DAEMON_URL}/status)` with `daemonFetch('/status', …)`, keep error handling.
- `halt/route.ts`: delete the ad-hoc bearer injection (:31-38) — daemonFetch owns it.
- Sweep EVERY `daemonFetch` caller (grep is authoritative). API routes: add `DaemonAuthError` handling returning 500-family JSON with the actionable message. Known floor: `app/api/daemon/{status,pause,resume,halt,release,issues/scan,remote-control/restart,repos-reload}/route.ts`, `app/api/decisions/pending/route.ts`, `app/api/decisions/[id]/route.ts`, `app/api/decisions/answer/route.ts`, `app/api/decisions/[id]/reveal/route.ts`, `app/api/metrics/escalation/route.ts`. Non-route callers — server actions (`actions/repos.ts:40`, `actions/github-connections.ts:9`) and server components (`app/(dashboard)/metrics/page.tsx:22`, `app/(dashboard)/steering/page.tsx:37`, `app/(dashboard)/page.tsx`): treat `DaemonAuthError` exactly like their existing `DaemonConfigError`/unreachable handling (degrade to offline/error state), but include the auth message so the operator can distinguish misconfiguration from a down daemon.
- Tests: daemon-fetch unit tests (bearer on GET+POST when set; absent when unset; not overridable; 401→DaemonAuthError); update halt proxy test; representative proxy-route tests (one mutating, one GET) asserting the auth-error JSON.

Commit: `feat(dashboard): forward control token on all daemon calls; map auth errors`

## Task 7 — remaining clients

- `packages/briefing-summarizer/src/signals.ts:99`: add bearer header from `process.env.RUNFORGE_CONTROL_TOKEN` when set.
- `packages/concierge/src/observer/daemon-poll.ts:45`, `src/tools/ac.ts:18-38`, `src/core/process-clients.ts:99-102`: same. Update `src/tools/ac.test.ts:34-39` and `src/core/process-clients.test.ts:88-103` (assert bearer when env set).
- `packages/daemon/src/main.ts` `callApi` (:139): bearer from env; if unset, read `RUNFORGE_CONTROL_TOKEN` from repo-root `.env.mac` if the file exists (simple line parse, no new dep). `packages/daemon/src/control-plane/cli.ts:62-66`: if genuinely unimported by any entrypoint, delete it + its test; otherwise apply the same bearer logic.

Commit: `feat: all control-plane clients send the bearer token`

## Task 8 — deployment plumbing

- `docker-compose.yml`: add `RUNFORGE_CONTROL_TOKEN: ${RUNFORGE_CONTROL_TOKEN:?set RUNFORGE_CONTROL_TOKEN in the selected env file}` to daemon, dashboard, and briefing-summarizer services (pattern of `RUNFORGE_DOCKER_DATABASE_URL`).
- `scripts/install-daemon.sh`: if `RUNFORGE_CONTROL_TOKEN` absent from `.env.mac`, generate `openssl rand -hex 32`, append to `.env.mac` (file kept 0600), and substitute into the plist. Idempotent: re-run reuses the existing token.
- `scripts/com.runforge.daemon.plist`: add `RUNFORGE_CONTROL_TOKEN` placeholder in `EnvironmentVariables`.
- `scripts/sync-claude-creds.sh`: validation log → 0600 file inside `$CREDS_DIR` (or `mktemp` with 0600), not `/tmp/sync-claude-creds.validate`.
- `.env.mac.example`, `.env.prod.example`, `docs/running.md`: document the token, rotation, and the exact compose invocation `ENV_FILE=.env.mac docker compose --env-file .env.mac …` (both mechanisms required — interpolation vs service `env_file`).

Commit: `ops: provision RUNFORGE_CONTROL_TOKEN across compose, launchd, docs; fix creds log perms`

## Task 9 — dependency hygiene

```bash
pnpm audit --prod --audit-level high   # inventory first
```
- Upgrade `next` within v16 to latest patched; upgrade other direct deps where that clears advisories.
- Add root `package.json` `"pnpm": { "overrides": { … } }` with minimal exact pins (resolve versions from the registry NOW — path-to-regexp, picomatch, fast-uri, undici, vite, hono as needed) until `pnpm audit --prod --audit-level high` exits 0. Prefer classification/upgrade over override for dev-graph noise (better-auth peer graph pulling vitest/jsdom).
- Create `docs/security-overrides.md`: one line per override — package, pin, advisory ID, date.
- `pnpm install` (lockfile updates), then full `pnpm typecheck && pnpm test && pnpm build` — overrides can break runtime deps; fix or drop the offending pin (never ship red).

Commit: `chore(deps): clear high prod audit findings via upgrades + pnpm overrides`

## Task 10 — CI security job

File: `.github/workflows/ci.yml`.

- **Gating constraint:** the autonomous merge gate polls only the exact required check names (`runforge.config.json:60` → `requiredChecks: ["ci"]`; `packages/daemon/src/control-plane/await-checks.ts:104`). A sibling job would NOT block landing. Therefore add the security steps **inside the existing `ci` job**, early (right after `pnpm install --frozen-lockfile`, before lint): step `Audit (prod, high)` → `pnpm audit --prod --audit-level high`; step `Gitleaks (full history)` → download a pinned gitleaks release binary (verify sha256 checksum) and run `gitleaks detect --redact`. The `ci` job's checkout needs `fetch-depth: 0` for full-history scanning. Do NOT change `requiredChecks` (that is deployment policy). CONSTRAINT: no job-level `services:`/`container:`/`uses: docker://…` (`scripts/check-ci-workflows.mjs` guard).
- Verify locally: `node scripts/check-ci-workflows.mjs` exits 0.

Commit: `ci: add security job (prod audit gate + gitleaks full-history)`

## Task 11 — full gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm check:traceability && pnpm check:workflows
gitleaks detect --redact
pnpm audit --prod --audit-level high   # exit 0
```
All green before opening the PR.

## Dependency order

Task 1 independent. Task 2 → {3,4,5}. Task 6,7 depend on 3 (behavior locked). Task 8 independent after 5. Task 9,10 independent. Task 11 last.

## Verification design (Phase 9, post-merge, run by conductor)

1. Start daemon locally with `RUNFORGE_CONTROL_TOKEN=testtoken` (loopback): `curl -s -o /dev/null -w '%{http_code}' localhost:3847/status` → 401; with `-H 'Authorization: Bearer testtoken'` → 200; `POST /pause` with bearer+`X-Requested-By` → 200; `GET /health` tokenless → 200.
2. `DAEMON_HOST=0.0.0.0` without token → process exits with ControlBindError message.
3. Tokenless loopback start → warning logged, requests work (legacy mode).
4. `pnpm audit --prod --audit-level high` → exit 0. `gh run list --workflow=ci.yml` → security job present + green on the PR run.
5. Dashboard (if running): status page renders via daemonFetch with bearer.

## Follow-up issues to file (Phase 8/9, `gh issue create`)

1. Extract server.ts routing/middleware/handlers (mechanical refactor).
2. Decompose daemon.ts startDaemon() into phase modules.
3. Operator decision: widen gate1Commands + set baselinePreexistingFailures:false.
4. Remove legacy loopback unauthenticated mode after one release cycle.
5. Remove or properly auth the built-in HTML dashboard (control-plane/dashboard.ts).
