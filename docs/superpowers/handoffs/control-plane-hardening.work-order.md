---
topic: control-plane-hardening
plan: docs/superpowers/plans/2026-07-07-control-plane-hardening.md
spec: docs/superpowers/specs/2026-07-07-control-plane-hardening-design.md
acceptance_tests:
  - packages/daemon/src/control-plane/__acceptance__/control-auth.acceptance.test.ts
  - packages/daemon/src/control-plane/__acceptance__/server-auth.acceptance.test.ts
verify_command: "pnpm --filter @runforge/daemon exec vitest run src/control-plane/__acceptance__"
branch: codex/control-plane-hardening-build
base_branch: worktree-review-findings-hardening
result_path: docs/superpowers/handoffs/control-plane-hardening.result.md
findings_path: docs/superpowers/handoffs/control-plane-hardening.findings.md
do_not_modify:
  - packages/daemon/src/control-plane/__acceptance__/control-auth.acceptance.test.ts
  - packages/daemon/src/control-plane/__acceptance__/server-auth.acceptance.test.ts
  - docs/superpowers/specs/**
  - docs/superpowers/plans/**
conventions: AGENTS.md
---

## Task

Implement the control-plane hardening exactly per the spec (`docs/superpowers/specs/2026-07-07-control-plane-hardening-design.md` — authoritative on behavior) and plan. The full task list, inline. Dependency order: Task 1 independent; Task 2 → {3,4,5}; Tasks 6,7 after 3; Task 8 after 5+6+7; Tasks 9,10 independent; Task 11 last. Keep every commit boundary green (`pnpm check:traceability`, daemon tests).

NOTE — dot-directory files you must open by EXPLICIT path (globbing skips them):
`.specify/stack/operator-auth-ts.md`, `.specify/architecture/operator-auth.md`, `.specify/functional/operator-auth.md`, `.specify/traceability.yml`, `.github/workflows/ci.yml`, `.env.mac.example`, `.env.prod.example`, `.gitleaks.toml`.

### Task 0 — Baseline
`pnpm install --frozen-lockfile`, then `pnpm --filter @runforge/daemon run test` must pass (the `__acceptance__` tests are EXPECTED to fail until you implement — run the rest of the suite to confirm baseline). Do NOT modify the acceptance tests, ever.

### Task 1 — .specify updates
Files: `.specify/stack/operator-auth-ts.md` (STACK-AC-OPERATOR-AUTH), `.specify/architecture/operator-auth.md`, `.specify/functional/operator-auth.md`, `.specify/traceability.yml`.
- Extend STACK-AC-OPERATOR-AUTH with the daemon control-plane auth model: bearer `RUNFORGE_CONTROL_TOKEN` on every route except `GET /health` (both servers); bind-host startup gate (IPv4-only contract, loopback = 127.0.0.0/8; non-loopback + no token = refuse to start); legacy loopback mode (loopback + no token = start with loud warnings, `/halt` token-optional); `X-Requested-By` demoted to CSRF/provenance defense on mutating methods; built-in HTML dashboard = legacy/loopback-only.
- Update ARCH/FUNC parents only where they describe the boundary ("role enforcement happens in the dashboard" → "dashboard enforces roles; daemon enforces the bearer boundary").
- traceability.yml: under the operator-auth stack spec add code_paths that exist now: `packages/daemon/src/control-plane/server.ts`, `packages/daemon/src/control-plane/degraded-server.ts`, `packages/dashboard/lib/daemon-fetch.ts`, `docker-compose.yml`, `scripts/install-daemon.sh`, `scripts/com.runforge.daemon.plist`; test_paths: `packages/daemon/src/control-plane/server.test.ts`. (`control-auth.*` entries land in Task 2's commit.)
- Verify `pnpm check:traceability` exits 0.
Commit: `spec(operator-auth): daemon control-plane bearer boundary + traceability`

### Task 2 — control-auth.ts (TDD)
New: `packages/daemon/src/control-plane/control-auth.ts` + `control-auth.test.ts`. API (must satisfy the acceptance tests exactly):
```ts
export class ControlBindError extends Error {}
export function isLoopbackHost(host: string): boolean        // IPv4 127.0.0.0/8 only
export function assertBindAllowed(host: string, token: string | undefined): void
export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; error: string }
export function checkAuthorization(authorizationHeader: string | string[] | undefined, token: string): AuthResult
```
- non-loopback + missing/empty token → ControlBindError with actionable message; loopback + no token → ok (caller warns).
- checkAuthorization: missing header → 401; non-Bearer scheme or wrong value → 403; compare Buffer byte lengths FIRST, then crypto.timingSafeEqual (throws on length mismatch otherwise).
- Own unit tests in control-auth.test.ts (matrix per plan Task 2) + add both new files to `.specify/traceability.yml` in this commit; `pnpm check:traceability` green.
Commit: `feat(daemon): control-plane auth primitives (bind gate + bearer check)`

### Task 3 — server.ts enforcement
File: `packages/daemon/src/control-plane/server.ts`.
- Read `RUNFORGE_CONTROL_TOKEN` per request (mirror how /halt reads it today ~line 152, so tests can toggle env).
- BEFORE route dispatch and body reads: token configured → `checkAuthorization(req.headers.authorization, token)`; failure → 401/403 JSON `{error}` for every path except `GET /health`. Token not configured → allow, log rate-limited deprecation warning (≤1/minute).
- Keep the X-Requested-By presence check for POST/PUT, running AFTER the bearer check.
- /halt: remove its ad-hoc token block (globally covered now); with no token configured it stays reachable with only the CSRF header.
- `createControlServer(port, handlers, host)`: call `assertBindAllowed(host, process.env.RUNFORGE_CONTROL_TOKEN)` before listen.
- Update `server.test.ts`: matrix {token set, unset} × {mutating POST, sensitive GET (/status, /decisions/pending), GET /health, /halt} → {2xx/expected, 401, 403}; save/restore RUNFORGE_CONTROL_TOKEN per test (pattern: `phase0-halt.gate.test.ts` lines ~15, 102-104); REWRITE the test at server.test.ts:499-504 (currently asserts tokenless '0.0.0.0' succeeds) to set a token, and add a fail-closed assertion (ControlBindError) for tokenless non-loopback.
Commit: `feat(daemon): require bearer on control plane; fail closed off-loopback`

### Task 4 — degraded-server.ts
Same rule via checkAuthorization: `/status` requires bearer when token set; `GET /health` always open; `assertBindAllowed` before listen. Tests in a degraded-server test file.
Commit: `feat(daemon): degraded server honors control token`

### Task 5 — daemon startup gate
File: `packages/daemon/src/control-plane/daemon.ts` (host resolution ~604-612, degraded server start ~672-678).
- After resolving daemonHost: `assertBindAllowed(daemonHost, process.env.RUNFORGE_CONTROL_TOKEN)`; ControlBindError = fatal startup error with actionable message. Loopback + no token → log legacy-mode startup warning once.
- Daemon-level test: non-loopback + no token refuses startup; loopback + no token starts with warning.
Commit: `feat(daemon): refuse non-loopback bind without control token`

### Task 6 — dashboard client + proxy sweep
Files: `packages/dashboard/lib/daemon-fetch.ts`, `packages/dashboard/app/(dashboard)/page.tsx`, `packages/dashboard/app/api/daemon/halt/route.ts`, all daemonFetch callers.
- daemonFetch: when env token set, set `Authorization: Bearer <token>` AFTER merging caller headers (not overridable). On daemon 401/403 throw typed `DaemonAuthError` (export beside DaemonConfigError; message: control token missing or invalid — set RUNFORGE_CONTROL_TOKEN in the dashboard environment).
- page.tsx (~line 24): replace direct `fetch(${DAEMON_URL}/status)` with daemonFetch('/status', …), keep error handling.
- halt/route.ts: delete ad-hoc bearer injection (~lines 31-38).
- Sweep EVERY daemonFetch caller (grep is authoritative). API routes → catch DaemonAuthError, return 500-family JSON with the actionable message. Known floor: `app/api/daemon/{status,pause,resume,halt,release,issues/scan,remote-control/restart,repos-reload}/route.ts`, `app/api/decisions/pending/route.ts`, `app/api/decisions/[id]/route.ts`, `app/api/decisions/answer/route.ts`, `app/api/decisions/[id]/reveal/route.ts`, `app/api/metrics/escalation/route.ts`. Non-route callers — server actions (`actions/repos.ts` ~40, `actions/github-connections.ts` ~9) and server components (`app/(dashboard)/metrics/page.tsx` ~22, `app/(dashboard)/steering/page.tsx` ~37, `app/(dashboard)/page.tsx`): treat DaemonAuthError like their existing DaemonConfigError/unreachable handling (degrade to offline/error state) but include the auth message.
- Tests: daemon-fetch unit tests (bearer on GET+POST when set; absent when unset; not overridable; 401→DaemonAuthError); update halt proxy test; representative proxy-route tests (one mutating + one GET) asserting the auth-error JSON.
Commit: `feat(dashboard): forward control token on all daemon calls; map auth errors`

### Task 7 — remaining clients
- `packages/briefing-summarizer/src/signals.ts` (~99): bearer from env when set.
- `packages/concierge/src/observer/daemon-poll.ts` (~45), `src/tools/ac.ts` (~18-38), `src/core/process-clients.ts` (~99-102): same. Update `src/tools/ac.test.ts` (~34-39) and `src/core/process-clients.test.ts` (~88-103) to assert the bearer when env set.
- `packages/daemon/src/main.ts` callApi (~139): bearer from env; if unset, read RUNFORGE_CONTROL_TOKEN from repo-root `.env.mac` if the file exists (simple line parse, no new dep). `packages/daemon/src/control-plane/cli.ts` (~62-66): if genuinely unimported by any entrypoint, delete it + its test; otherwise apply the same bearer logic.
Commit: `feat: all control-plane clients send the bearer token`

### Task 8 — deployment plumbing (after 5+6+7)
- `docker-compose.yml`: add `RUNFORGE_CONTROL_TOKEN: ${RUNFORGE_CONTROL_TOKEN:?set RUNFORGE_CONTROL_TOKEN in the selected env file}` to daemon, dashboard, briefing-summarizer, and any composed concierge service (pattern of RUNFORGE_DOCKER_DATABASE_URL).
- `scripts/install-daemon.sh`: if RUNFORGE_CONTROL_TOKEN absent from `.env.mac`, generate `openssl rand -hex 32`, append (file kept 0600), substitute into plist. Idempotent. Support `RUNFORGE_ENV_MAC_PATH` override for testability. Acceptance check (RUN it): point the override at a temp file, run provisioning twice, assert identical token line + mode 0600 (skip launchctl).
- `scripts/com.runforge.daemon.plist`: add RUNFORGE_CONTROL_TOKEN placeholder in EnvironmentVariables.
- `scripts/sync-claude-creds.sh`: validation log → 0600 file inside $CREDS_DIR (or mktemp 0600), NOT /tmp/sync-claude-creds.validate.
- `.env.mac.example`, `.env.prod.example`, `docs/running.md`: document token, rotation, and the exact compose invocation `ENV_FILE=.env.mac docker compose --env-file .env.mac …` (both mechanisms required).
Commit: `ops: provision RUNFORGE_CONTROL_TOKEN across compose, launchd, docs; fix creds log perms`

### Task 9 — dependency hygiene
- `pnpm audit --prod --audit-level high` to inventory. Upgrade `next` within v16 to latest patched; upgrade other direct deps where that clears advisories.
- Root `package.json` `"pnpm": { "overrides": { … } }` with minimal exact pins (resolve real versions from the registry) until `pnpm audit --prod --audit-level high` exits 0. Prefer classification/upgrade over override for dev-graph noise (better-auth peer graph pulling vitest/jsdom).
- Create `docs/security-overrides.md`: one line per override — package, pin, advisory ID, date.
- `pnpm install`, then `pnpm typecheck && pnpm test && pnpm build` — fix or drop any pin that breaks runtime; never ship red.
Commit: `chore(deps): clear high prod audit findings via upgrades + pnpm overrides`

### Task 10 — CI security steps (inside the `ci` job)
File: `.github/workflows/ci.yml`. Add INSIDE the existing required `ci` job (a sibling job would NOT gate — requiredChecks is ["ci"]), right after `pnpm install --frozen-lockfile`: step `Audit (prod, high)` → `pnpm audit --prod --audit-level high`; step `Gitleaks (full history)` → download a pinned gitleaks release binary (verify sha256) and run `gitleaks detect --redact`; set the ci job's checkout `fetch-depth: 0`. Do NOT change requiredChecks. No job-level `services:`/`container:`/`uses: docker://…` (guard: `scripts/check-ci-workflows.mjs`). Verify `node scripts/check-ci-workflows.mjs` exits 0.
Commit: `ci: add security steps to ci job (prod audit gate + gitleaks full-history)`

### Task 11 — full gates (last)
```
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm check:traceability && pnpm check:workflows
pnpm audit --prod --audit-level high
```
All green, acceptance tests green via verify_command.

## Definition of done
- acceptance tests pass via verify_command; TDD for new code; do not modify acceptance tests
- all Task 11 gates green
- push branch `codex/control-plane-hardening-build` and open a PR against `main` (template below), then write result.md at result_path (frontmatter: status, pr, branch, verify_command_result; body: done list, risks, dead-ends)

## PR template
Title: `security: control-plane bearer auth, dependency audit gate, secrets hardening`
Body: Summary of the four hardening areas (auth boundary, deps, secrets, spec coverage); link `docs/superpowers/specs/2026-07-07-control-plane-hardening-design.md` and `docs/superpowers/plans/2026-07-07-control-plane-hardening.md`; test plan checklist (acceptance tests, daemon matrix, dashboard tests, installer idempotence check, audit exit 0, gitleaks clean, check-ci-workflows green); note the deliberate docker fail-closed upgrade behavior and legacy loopback mode; end with:
🤖 Generated with [Claude Code](https://claude.com/claude-code)
