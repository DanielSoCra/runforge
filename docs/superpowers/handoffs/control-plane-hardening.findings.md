# Control-Plane Hardening — Implementation Deep-Review Findings

Review of `git diff origin/main...HEAD` (branch `codex/control-plane-hardening-build`, PR #1).
Lanes: Claude adversarial review + codex `exec review --base main` (gpt-5.5, high effort). Merged and deduped; every codex finding independently verified against code + design spec.

**Verdict: NOT-CLEAN** — 0 critical, 3 important-on-new-code.

## Gate results (all green)

- `pnpm --filter @runforge/daemon exec vitest run src/control-plane/__acceptance__` — 2 files, 12 tests passed
- `pnpm check:traceability` — 738 path entries clean
- `node scripts/check-ci-workflows.mjs` — 1 workflow clean
- Extra: daemon control-plane unit suites (115 tests) and dashboard daemon-fetch/daemon-route suites (77 tests) passed

## IMPORTANT (on new code)

### I1 — `sync-claude-creds.sh` breaks first-time sync when `CREDS_DIR` does not exist yet
`scripts/sync-claude-creds.sh:52-53` — the new validation-log `mktemp "${CREDS_DIR}/.sync-claude-creds.validate.XXXXXX"` runs **before** the `mkdir -p "${CREDS_DIR}"` at step 3 (line ~71). On a fresh install where the bind-mount creds dir does not exist, `mktemp` fails and `set -euo pipefail` aborts the script before `.credentials.json` is ever written. This is a regression introduced by moving the log out of `/tmp` (the old code worked because nothing touched `CREDS_DIR` before the `mkdir -p`). Fix: `mkdir -p "${CREDS_DIR}"` before the `mktemp`. *(codex, verified)*

### I2 — CLI `.env.mac` token fallback resolves from `cwd`, not the repo root (spec deviation)
`packages/daemon/src/main.ts:133-135` and the duplicate in `packages/daemon/src/control-plane/cli.ts:64-66` — `resolveControlToken()` reads `resolve(process.cwd(), '.env.mac')`. The design spec (2026-07-07-control-plane-hardening-design.md, "daemon CLI" bullet) requires the **repo-root** `.env.mac`. Running the CLI from any subdirectory (e.g. `pnpm --filter @runforge/daemon ...` sets cwd to `packages/daemon`) silently finds no token, so `status`/`pause`/`resume` fail with 401 against a token-protected daemon. Fix: resolve from repo root (e.g. walk up to a `.git`/`pnpm-workspace.yaml` marker or use module location). *(codex, verified)*

### I3 — `metrics/escalation` and `decisions/pending` proxies swallow `DaemonAuthError` silently (spec deviation)
`packages/dashboard/app/api/metrics/escalation/route.ts:43-46` and `packages/dashboard/app/api/decisions/pending/route.ts:51-56` — both catch `DaemonAuthError` but return the exact same degraded 200 payload as the generic catch, with no log and no actionable message (the added `if` branch is a no-op). The design spec requires **every** `daemonFetch` caller to return a 500-family JSON with the actionable RUNFORGE_CONTROL_TOKEN message so auth failures don't collapse into "unavailable data". Token misconfiguration on these two routes is invisible to the operator. Fix: return a 500 with `e.message` (or at minimum `console.error` it) for the `DaemonAuthError` branch. *(codex, verified)*

## MINOR

- **`checkAuthorization` scheme match is now case-sensitive** — `packages/daemon/src/control-plane/control-auth.ts:44` requires exactly `Bearer`; the replaced `/halt` code accepted `bearer` (`parts[0]?.toLowerCase()`). RFC 7235 auth schemes are case-insensitive; a lowercase-scheme client that worked before now gets 403. All in-repo callers send `Bearer`, so impact is external-client only.
- **`install-daemon.sh` provisioning trusts inherited shell env** — `scripts/install-daemon.sh:16-31` — `provision_control_token` sources `$ENV_FILE` and skips appending when `RUNFORGE_CONTROL_TOKEN` is already non-empty; a token exported in the operator's shell (but absent from `.env.mac`) means the plist gets the shell token while compose consumers of `.env.mac` get nothing → daemon/dashboard token mismatch. Also `chmod 600 "$ENV_FILE"` is applied only on the generate path, not when a token already exists.
- **Duplicated `resolveControlToken`** in `packages/daemon/src/main.ts` and `packages/daemon/src/control-plane/cli.ts` (design explicitly allowed updating both, so tracked as a consolidation cleanup only; fix together with I2).
- **`packages/concierge/src/tools/ac.ts:56-63`** — `init.headers` is cast to `Record<string, string | string[]>`; a `Headers` instance or entries-array would be silently mangled. All current in-file callers pass plain objects.
- **Env-var mutation in test files** (`process.env.RUNFORGE_CONTROL_TOKEN` set/deleted across several daemon test files) relies on vitest worker isolation; a future pool-config change could introduce cross-file flakiness. Save/restore hygiene is present everywhere.

## Pre-existing (not introduced by this diff)

- `daemonFetch` spreads `options?.headers` (`packages/dashboard/lib/daemon-fetch.ts:24`) — a `Headers` instance would spread to nothing. Pre-existing pattern; all callers pass plain objects. The new code correctly spreads the `Authorization` override *after* caller headers, so callers cannot override it (tested).

## Verified-correct highlights (no findings)

- Timing-safe compare with length pre-check and try/catch; 401 (missing header) vs 403 (bad token) mapping matches spec.
- `/health` exempt on both the control server and the degraded server; bearer check runs **before** the X-Requested-By CSRF check; `/halt` folded into the global boundary with identical legacy semantics.
- `assertBindAllowed` at all three listen paths (`server.ts:106`, `degraded-server.ts:32`, `daemon.ts:617` startup gate) — tokenless non-loopback refuses before `listen`, with tests asserting `listen` is never called.
- Legacy loopback mode: startup warning in `daemon.ts` + rate-limited (60 s) per-request warning in `server.ts`.
- All three concierge call sites, briefing-summarizer, dashboard `page.tsx`, and both CLI `callApi`s attach the bearer; `DaemonAuthError` is mapped in every mutating proxy route (except the two GET proxies in I3).
- Compose `${RUNFORGE_CONTROL_TOKEN:?}` on all three daemon-calling services; plist placeholder + installer substitution; `pnpm.overrides` in root `package.json` exactly match `docs/security-overrides.md`.
- CI: `fetch-depth: 0`, pinned gitleaks 8.30.1 with sha256 verification, audit + gitleaks as steps **inside** the `ci` job; `check-ci-workflows.mjs` passes (no services/container violations).
