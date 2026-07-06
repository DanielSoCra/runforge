> **🗄 HISTORICAL (2026-06-02).** Implementation-complete execution log, kept for provenance. The active design is `docs/superpowers/specs/2026-05-21-daemon-db-outage-resilience-design.md`; the canonical current specs live in `.specify/`. See `docs/superpowers/specs/2026-05-29-spec-reconciliation-ledger.md`. <!-- RECONCILIATION-LEDGER-BANNER -->

# Daemon DB-Outage Resilience — Implementation Plan (option E′)

> **For agentic workers:** REQUIRED SUB-SKILLS: `superpowers:subagent-driven-development` (or `executing-plans`) + `superpowers:test-driven-development`. Tasks are bite-sized; **Dependency notes** state ordering. Steps use `- [ ]` checkboxes.

**Goal:** The daemon survives a transient *unreachable* Data Service outage during startup without exiting: it binds a throwaway minimal observability server, runs bounded inline retry against the DB, and if exhausted it blocks in a background-retry loop (degraded `/health` reachable, no work claimed) until the DB recovers — then proceeds through its **unchanged** normal startup. It escalates to the Operator after the existing consecutive-failure threshold and **fails loudly** (process exit, cause surfaced) on a permanent *rejected* outcome (schema/auth/permission). Driver causes are surfaced everywhere a failure is logged.

**Why E′ (throwaway degraded server + linear blocking recovery)** instead of reordering the real server / extracting `completeStartup`: plan-review round 1+2 showed the real startup body (lines ~201–1390: services, repoManager, crash resumption, heartbeat, parked-run resume, signal handlers, real server) is tightly coupled and its handlers reference functions defined throughout. Extracting/reordering it is a 700-line restructure with high regression risk. E′ leaves that body **completely unchanged** and runs it linearly once config has loaded. The degraded window is served by a separate ~40-line throwaway server.

**Spec:** `docs/superpowers/specs/2026-05-21-daemon-db-outage-resilience-design.md`. **Codex:** spec round 4 CLEAN; plan revised to E′ after plan-review rounds 1–2.

**Verified facts (do not re-derive):**
- `Result<T, E = Error>` + `ok`/`err`/`isOk`/`isErr` in `packages/daemon/src/lib/result.ts`.
- `StoreResult` (`packages/db/src/stores.ts`): `ok` | failures `not-found` | `denied` | `unavailable`.
- `NotificationPayload` (`packages/daemon/src/control-plane/notify.ts`): `{ event: string; issueNumber: number; phase?: string; message: string }`. `event` is a free string. Daemon calls `notify(config.webhooks, payload)` (e.g. daemon.ts:570, 670).
- `config.maxConsecutiveStuck` is real (`packages/daemon/src/config.ts:208`, used at `daemon.ts:663-665`).
- `ConfigReader` interface (`config-reader.ts:19`) exposes `start`, `stop`, `getGlobalConfig`, `getRepoConfig`. Production var typed `ConfigReader | null` at `daemon.ts:184`. Mocks exist in `daemon.test.ts`.
- `PostgresConfigReader.start()` currently `await this.fetch()` then arms a 60s `setInterval(fetchSafe)`. `fetch()` reads global settings (`not-found`→DEFAULT_GLOBAL at line 65), enabled repos, active plugins.
- The control server binds at `daemon.ts:934` (`createControlServer(...).start()`); instance lock = the port `listen()` at `server.ts:180`. `/health`→`{ok:true}` (server.ts:51).
- DB-dependent startup steps (fail if Postgres down): `configReader.start()` (201), `runMaintenance.markInProgressRunsStuck()` (212), `repoManager.initialize()` (925). In E′ these are unchanged and all run after config load.
- Tests: per-package, `cd packages/<pkg> && pnpm vitest run <path>`. Root `pnpm -r run {typecheck,lint,test}`. `pnpm install` required in worktree first.
- The Mac Mini daemon runs under launchd (`scripts/com.runforge.daemon.plist`, `KeepAlive`+`ThrottleInterval=30`). Plist is NOT changed.

---

## startDaemon shape after this plan

```
// Phase A — non-DB preflight (UNCHANGED, top of startDaemon):
//   GITHUB_TOKEN check, loadConfig, runtime-source validate, prompt contracts,
//   prompt-cache prewarm, governance preload, StateManager.initialize, readDaemonDataBackendKind.
// Phase B — create DB client + stores + configReader (NO DB I/O). [existing lines ~191-210, minus the start() call]
// Phase C — bind throwaway degraded server on config.controlPort.            [NEW]
// Phase D — bounded inline retry of configReader.tryFetch():                  [NEW]
//   rejected  → degradedServer.close(); postgresClient.sql.end(); return err(...)
//   exhausted → await runDegradedUntilRecovered(...)  // blocks; exits on rejected
//   (success or post-recovery) → fall through
//   degradedServer.close();   // release the port
// ---- existing startup body UNCHANGED from here: configReader.start() (now timer-only),
//      orphaned-run cleanup, services, repoManager, real control server bind, work loop,
//      crash resume, heartbeat, signal handlers. ----
```

---

## File Structure

| File | Action |
|------|--------|
| `packages/db/src/stores.ts` | Modify — `unavailable` gains required `category` + `cause` |
| `packages/db/src/postgres-stores.ts` | Modify — `classifyDriverError`, cause-walk, message format |
| `packages/db/src/postgres-stores.test.ts` | Create/modify — classification tests |
| `packages/daemon/src/data/config-reader.ts` | Modify — interface + `tryFetch` + `isStartupDegraded`/`getLastConfigError`; `start()` timer-only |
| `packages/daemon/src/data/config-reader.test.ts` | Modify — tryFetch + start()-timer-only |
| `packages/daemon/src/control-plane/startup-retry.ts` | Create — bounded-retry helper |
| `packages/daemon/src/control-plane/startup-retry.test.ts` | Create |
| `packages/daemon/src/control-plane/degraded-server.ts` | Create — throwaway `/health`+`/status` server |
| `packages/daemon/src/control-plane/degraded-server.test.ts` | Create |
| `packages/daemon/src/control-plane/daemon.ts` | Modify — Phase C + D + `runDegradedUntilRecovered`; `start()` call unchanged in place |
| `packages/daemon/src/control-plane/daemon.test.ts` | Modify — degraded/recovery/rejected paths |
| `packages/daemon/src/control-plane/server.ts` | Modify (optional) — `/health` shape uniformity |
| `packages/daemon/src/main.ts` | Modify — cause-chain formatting |
| `.specify/traceability.yml` | Modify — add startup-retry.ts + degraded-server.ts + tests |
| `.specify/stack/operational-safety-ts.md` | Modify — frontmatter sync |

---

### Task 1: `StoreResult` unavailable gains required category + cause

**Files:** `packages/db/src/stores.ts` (+ compile-fix hand-built producers).
**Dependency notes:** Blocks 2, 3. No predecessor.

- [ ] **Step 1.** Locate the `StoreResult` union; extend the `unavailable` branch (both fields **required**):
  ```ts
  { ok: false; error: 'unavailable'; message: string;
    category: 'unreachable' | 'rejected';
    cause: { class: string; code: string | null; message: string } }
  ```
- [ ] **Step 2.** `cd packages/db && pnpm run typecheck`. For each non-exception `unavailable(...)` producer (logical-invariant cases like "update returned no row"), pass `category: 'rejected'` + `cause: { class: 'StoreInvariant', code: null, message }`. Minimum to compile; real classification is Task 2.
- [ ] **Step 3.** `cd packages/db && pnpm vitest run`. Green.

**Commit:** `db(stores): extend StoreResult unavailable with required category and cause`

---

### Task 2: `classifyDriverError` + cause-walk in `postgres-stores.ts`

**Files:** `packages/db/src/postgres-stores.ts`, `postgres-stores.test.ts`.
**Dependency notes:** Blocked by 1.

- [ ] **Step 1.** Add `classifyDriverError(err): { category, class, code, message }`. Walk `err.cause` iteratively (depth cap 10, cycle-safe). Pick the **deepest** layer with a non-empty `code` OR non-default `name`/`constructor.name` (≠ `'Error'`).
- [ ] **Step 2.** Category: `unreachable` if `code ∈ {ECONNREFUSED,ETIMEDOUT,ENOTFOUND,ECONNRESET,EPIPE}` or `code` starts `'08'`; else `rejected` (incl. opaque/no-code — conservative).
- [ ] **Step 3.** Rewrite `unavailableOnThrow` to call it and build the unavailable result; the `unavailable(...)` helper signature gains `(message, category, cause)`.
- [ ] **Step 4.** Message: `<existing drizzle message> — <code>: <cause.message>` (code present) / `… — <cause.message>` / `<existing message>`.
- [ ] **Step 5.** Tests: ECONNREFUSED→unreachable; 08006→unreachable; 28P01→rejected; 42P01→rejected; opaque→rejected; depth-3 chain→deepest; cyclic chain→terminates; message includes code.
- [ ] **Step 6.** `cd packages/db && pnpm vitest run`. Green.

**Commit:** `db(stores): classify driver errors (unreachable vs rejected) and surface cause`

---

### Task 3: `ConfigReader.tryFetch` + `start()` becomes timer-only

**Files:** `packages/daemon/src/data/config-reader.ts`, `config-reader.test.ts`.
**Dependency notes:** Blocked by 1.

- [ ] **Step 1.** Add type `ConfigFetchError { category: 'unreachable' | 'rejected'; cause: { class: string; code: string | null; message: string } }`.
- [ ] **Step 2.** Extend the `ConfigReader` interface with `tryFetch(): Promise<Result<void, ConfigFetchError>>`, `isStartupDegraded(): boolean`, `getLastConfigError(): ConfigFetchError | null`. Keep existing members. Update mocks (`daemon.test.ts`, any `implements ConfigReader`).
- [ ] **Step 3.** Add private `startupDegraded = true`, `lastConfigError: ConfigFetchError | null = null`.
- [ ] **Step 4.** Implement `tryFetch()` — same reads as today's `fetch()` but returns `Result<void, ConfigFetchError>` instead of throwing:
  - global-settings `not-found` → DEFAULT_GLOBAL (success).
  - any read `unavailable` → `err({ category: r.category, cause: r.cause })`, set `lastConfigError`.
  - any read `denied` → `err({ category: 'rejected', cause: { class: 'StoreDenied', code: null, message: r.message } })`.
  - all ok → assign config + repoConfigs, set `startupDegraded = false`, clear `lastConfigError`, return `ok`.
  - **`startupDegraded` is set `false` once (on the first successful load) and is NEVER set back to `true`.** A failed `tryFetch` after the daemon has recovered must not flip it back to degraded — runtime DB-outage resilience is explicitly out of scope, and the steady-state timer keeps last-known-good. Guard: only the constructor sets the initial `true`; only success sets `false`.
- [ ] **Step 5.** Change `start()` to **only** arm the timer (`setInterval`); REMOVE the `await this.fetch()` line. The timer callback stays `fetchSafe` (keep last-known-good + `console.warn`) — unchanged steady-state behavior. (The initial load is now the daemon's bounded-retry responsibility via `tryFetch`.)
- [ ] **Step 6.** Keep the private `fetch()`/`fetchSafe()` for the timer; `fetch()` may now delegate to `tryFetch()` and throw on `err` so `fetchSafe`'s existing catch still works. `getGlobalConfig`/`getRepoConfig` unchanged.
- [ ] **Step 7.** Tests: `tryFetch` ok updates config + clears degraded; `unreachable`/`rejected`/`denied` mapping with structured cause; `not-found`→DEFAULT_GLOBAL success; **`start()` no longer fetches** (assert the store read mock is NOT called by `start()` alone, only the timer fires it later). Update the existing "start fetches immediately" test to the new contract.
- [ ] **Step 8.** `cd packages/daemon && pnpm vitest run src/data/`. Green.

**Commit:** `daemon(config-reader): add tryFetch; start() arms timer only`

---

### Task 4: `startup-retry.ts` bounded-retry helper

**Files:** Create `startup-retry.ts` + `.test.ts`.
**Dependency notes:** Blocked by 1. Independent of 3.

- [ ] **Step 1.** Implement (see design doc for full signature):
  ```ts
  export interface StartupRetryOptions { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; delay?: (ms: number) => Promise<void>; }
  export interface RetryFailure { category: 'unreachable' | 'rejected'; cause: { class: string; code: string | null; message: string }; }
  export type StartupRetryResult = { kind: 'success' } | { kind: 'rejected'; failure: RetryFailure } | { kind: 'exhausted'; lastFailure: RetryFailure };
  export async function runStartupRetry(tryFetch, options, onAttempt): Promise<StartupRetryResult>;
  export function readStartupRetryOptions(env): StartupRetryOptions;
  ```
- [ ] **Step 2.** Backoff `Math.min(baseDelayMs * 2 ** (attempt-1), maxDelayMs)`. `delay` default `setTimeout`. success/rejected → return immediately; unreachable → onAttempt, delay, retry; **no delay after the final attempt**; exhausted → `{kind:'exhausted', lastFailure}`.
- [ ] **Step 3.** `readStartupRetryOptions`: `DAEMON_STARTUP_RETRY_MAX_ATTEMPTS`=5, `_BASE_MS`=1000, `_MAX_DELAY_MS`=16000. Garbage → default + `console.warn`, never throw.
- [ ] **Step 4.** Tests: ok-first (1 attempt, 0 delays); unreachable×3 then ok (4 attempts, delays `[1000,2000,4000]`); unreachable×5=max → exhausted, delays `[1000,2000,4000,8000]` (4 delays, none after attempt 5); rejected attempt 1 → rejected, 0 delays; cap (base 1000,max 5000,6 attempts → `[1000,2000,4000,5000,5000]`); `readStartupRetryOptions` parse + fallback.
- [ ] **Step 5.** `cd packages/daemon && pnpm vitest run src/control-plane/startup-retry.test.ts`. Green.

**Commit:** `daemon(control-plane): add bounded startup-retry helper with injectable clock`

---

### Task 5: `degraded-server.ts` throwaway observability server

**Files:** Create `degraded-server.ts` + `.test.ts`.
**Dependency notes:** Blocked by 3 (uses `ConfigFetchError` for the state shape). Independent of 4.

- [ ] **Step 1.** Implement:
  ```ts
  import { createServer, type Server } from 'http';
  export interface DegradedState { lastConfigError: ConfigFetchError | null; }
  export interface DegradedServerHandle { close(): Promise<void>; }
  export function createDegradedServer(
    port: number, host: string, getState: () => DegradedState,
  ): { start: () => Promise<Result<void>>; handle: DegradedServerHandle };
  ```
  Server answers ONLY: `GET /health` → 200 `{ ok: true, degraded: true, lastConfigError }`; `GET /status` → 200 `{ degraded: true, lastConfigError, uptime: process.uptime() }`; everything else → 503 `{ error: 'daemon starting (degraded)' }`. `start()` resolves `ok` once listening, `err` on `EADDRINUSE` (mirror server.ts:173's instance-lock message — the port IS the process lock). `close()` wraps `server.close()` in a Promise and is **idempotent + error-aware**: calling it when never-started or already-closed resolves without throwing (so cleanup paths can call it unconditionally).
- [ ] **Step 2.** Reuse the small `json(res, status, body)` helper pattern from `server.ts` (copy it locally — keep this file dependency-free of the big server).
- [ ] **Step 3.** Tests (bind to an ephemeral port like `0` or a high test port, `127.0.0.1`): `/health` returns the degraded shape with the injected `lastConfigError`; `/status` returns degraded; unknown path → 503; `start()` then `close()` releases the port (a second `start()` on the same port succeeds after close). Use `fetch` against the bound port.
- [ ] **Step 4.** `cd packages/daemon && pnpm vitest run src/control-plane/degraded-server.test.ts`. Green.

**Commit:** `daemon(control-plane): add throwaway degraded observability server`

---

### Task 6: Wire Phase C + D into `startDaemon`

**Files:** `packages/daemon/src/control-plane/daemon.ts`, `daemon.test.ts`.
**Dependency notes:** Blocked by 3, 4, 5. Blocks 7.

- [ ] **Step 0 (test seam).** Change the signature to `startDaemon(configPath: string, opts?: { startupRetry?: Partial<StartupRetryOptions>; degradedRecovery?: { intervalMs: number; delay?: (ms: number) => Promise<void> } })`. Production callers (`main.ts`) pass no opts; tests inject a fast `degradedRecovery.intervalMs`/`delay`. Do NOT add a test-only env var. The production degraded poll cadence reuses the config-reader's `DAEMON_SYNC_INTERVAL_MS` default (60s) when `opts.degradedRecovery` is absent. Also export `runDegradedUntilRecovered` so it can be unit-tested directly with an injected `delay`.
- [ ] **Step 1.** Hoist the `daemonHost`/`isIP(daemonHost)` validation block (currently lines 935–945; depends only on `process.env.DAEMON_HOST`, `config.controlHost`, `isIP`) up to Phase B, **before** `createDbClient`. Then after the postgres client + stores + `configReader` are created (current ~line 196–200) but BEFORE `await configReader.start()` (line 201), insert Phase C: build `degradedState = { lastConfigError: null }`, `const degraded = createDegradedServer(config.controlPort, daemonHost, () => degradedState)`.
- [ ] **Step 2.** `const startResult = await degraded.start(); if (!startResult.ok) { await postgresClient.sql.end(); return startResult; }`.
- [ ] **Step 2b (temporary signal cleanup).** Before Phase D, register a temporary SIGTERM/SIGINT handler that `await degraded.handle.close()` + `await postgresClient.sql.end()` then `process.exit(0)` — because the daemon's normal signal handlers are only registered late in the unchanged startup body, and a SIGTERM during the (possibly long) degraded block would otherwise skip cleanup. Capture the handler refs; remove them with `process.off(...)` immediately after `await degraded.handle.close()` (the port handoff point), so the normal handlers registered later are the only ones active in steady state.
- [ ] **Step 3.** Phase D — bounded inline retry, inside a `try`. Note `opts.startupRetry` is merged over env defaults, and `opts.degradedRecovery` (or a 60s default) is threaded into `runDegradedUntilRecovered`:
  ```ts
  const retryOptions = { ...readStartupRetryOptions(process.env), ...opts?.startupRetry };
  const recovery = opts?.degradedRecovery ?? { intervalMs: DEFAULT_SYNC_INTERVAL_MS };  // 60000
  const result = await runStartupRetry(
    () => configReader!.tryFetch(),
    retryOptions,
    ({ attempt, total, outcome }) => {
      if (outcome === 'ok') return;
      degradedState.lastConfigError = outcome;
      console.log(`[daemon] startup config fetch failed (attempt ${attempt}/${total}, ${outcome.category}, ${outcome.cause.code ?? 'no-code'}): ${outcome.cause.message}`);
    },
  );
  if (result.kind === 'rejected') {
    console.error(`[daemon] FATAL startup config rejected: ${result.failure.cause.code ?? 'no-code'}: ${result.failure.cause.message}`);
    await degraded.handle.close();
    await postgresClient.sql.end();
    // Attach cause so main.ts formatStartupError prints the `caused by:` line.
    return err(new Error(`startup config rejected: ${result.failure.cause.code ?? 'no-code'}: ${result.failure.cause.message}`, { cause: result.failure.cause }));
  }
  if (result.kind === 'exhausted') {
    console.warn(`[daemon] startup config exhausted ${retryOptions.maxAttempts} attempts — entering startup-degraded mode; background retry continues`);
    await runDegradedUntilRecovered(configReader!, degradedState, degraded.handle, postgresClient, {
      intervalMs: recovery.intervalMs,
      delay: recovery.delay,
      maxConsecutiveStuck: config.maxConsecutiveStuck,
      webhooks: config.webhooks,
    });
  }
  await degraded.handle.close();   // port handoff to the real server
  ```
  Wrap C+D in `try { ... } catch (e) { await degraded.handle.close().catch(()=>{}); await postgresClient.sql.end().catch(()=>{}); return err(e instanceof Error ? e : new Error(String(e))); }`.
- [ ] **Step 4.** Implement and **export** `runDegradedUntilRecovered(configReader, degradedState, degradedHandle, postgresClient, opts: { intervalMs: number; delay?: (ms:number)=>Promise<void>; maxConsecutiveStuck: number; webhooks: string[] })` as a top-level function (so it is unit-testable directly). It takes only the narrow params it needs — NOT the whole `config` — so the seam is clean:
  ```
  const delay = opts.delay ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  let consecutive = 0, notified = false;
  for (;;) {
    await delay(opts.intervalMs);
    const r = await configReader.tryFetch();
    if (r.ok) return;                                  // recovered → resolve
    degradedState.lastConfigError = r.error;
    const { code } = r.error.cause; const { message } = r.error.cause;
    if (r.error.category === 'rejected') {
      console.error(`[daemon] FATAL background config rejected: ${code ?? 'no-code'}: ${message}`);
      await degradedHandle.close(); await postgresClient.sql.end();
      process.exit(1);
    }
    consecutive++;
    console.log(`[daemon] startup config fetch failed (background, attempt ${consecutive}, unreachable, ${code ?? 'no-code'}): ${message}`);
    if (consecutive >= opts.maxConsecutiveStuck && !notified) {
      void notify(opts.webhooks, { event: 'startup-degraded', issueNumber: 0, phase: 'startup',
        message: `Daemon startup-degraded: Data Service unreachable after ${consecutive} background attempts (${code ?? 'no-code'}: ${message})` });
      notified = true;
    }
  }
  ```
  `intervalMs`/`delay` are injectable so tests don't wait 60s. `DEFAULT_SYNC_INTERVAL_MS` mirrors the config-reader's `DEFAULT_SYNC_INTERVAL_MS` (60000) — import or re-declare a shared constant.
- [ ] **Step 5.** Leave the rest of `startDaemon` (line 201 `configReader.start()` onward) UNCHANGED. Because `start()` is now timer-only (Task 3), it no longer re-fetches — config is already loaded by the inline/background `tryFetch`. The real control server still binds at its original place.
- [ ] **Step 5b (test infrastructure — do this before writing Step 6 cases).** In `daemon.test.ts`: (a) add a hoisted `vi.mock('./degraded-server.js')` whose `createDegradedServer` returns `{ start: async () => ok(undefined), handle: { close: async () => {} } }` by default, so existing `startDaemon` tests don't bind a real port (avoids `EADDRINUSE`/flake); override per-test where a test needs real degraded behavior. (b) Add `tryFetch` (default `async () => ok(undefined)`), `isStartupDegraded` (default `() => false`), and `getLastConfigError` (default `() => null`) to the hoisted `mockConfigReader` and its `beforeEach` reset (see daemon.test.ts:76, :258). Existing tests then pass unchanged (tryFetch resolves ok → no degraded path).
- [ ] **Step 6.** Tests (`daemon.test.ts`), driving `configReader.tryFetch` + injecting `opts.degradedRecovery = { intervalMs: 5, delay: async()=>{} }`:
  - `unreachable` once then `ok` → `startDaemon` resolves `ok`; normal startup ran (assert real server `/health` reachable, e.g. via the existing server test seam); degraded server closed.
  - `unreachable` for all `maxAttempts` then `ok` on first background poll → resolves `ok` after recovery; normal startup ran.
  - `rejected` inline attempt 1 → `startDaemon` returns `err`; assert `postgresClient.sql.end` + degraded close called; real server never bound.
  - degraded `/health` reachable while `tryFetch` keeps failing `unreachable` (prove observability during outage). Use a short poll interval + resolve after 2 polls.
  - background `rejected` → `process.exit` invoked (spy), degraded closed.
- [ ] **Step 7.** `cd packages/daemon && pnpm vitest run src/control-plane/daemon.test.ts`. Green.

**Commit:** `daemon(control-plane): degraded startup server + bounded retry + background recovery`

---

### Task 7: Optional `/health` shape uniformity + notifier confirm

**Files:** `packages/daemon/src/control-plane/server.ts`, `server.test.ts`.
**Dependency notes:** Blocked by 6. Low priority — cosmetic.

- [ ] **Step 1.** Real server `/health` (server.ts:51) → `{ ok: true, degraded: false, lastConfigError: null }` so the two servers share a shape. (The real server only binds post-recovery, so degraded is always false here.)
- [ ] **Step 2.** Update `server.test.ts` `/health` expectation.
- [ ] **Step 3.** `cd packages/daemon && pnpm vitest run src/control-plane/server.test.ts`. Green.

**Commit:** `daemon(server): align /health shape with degraded server`

---

### Task 8: `main.ts` cause-chain formatting

**Files:** `packages/daemon/src/main.ts`.
**Dependency notes:** Independent — parallel-safe.

- [ ] **Step 1.** Add `formatStartupError(error: Error): string` printing `Failed to start: <message>` + up to 5 `  caused by: [<code>] <message>` lines walking `error.cause`.
- [ ] **Step 2.** Use in the `start` `!result.ok` branch; wrap `program.parseAsync()` so top-level throws format the same way before `process.exit(1)`.
- [ ] **Step 3.** Smoke: `GITHUB_TOKEN=dummy RUNFORGE_DATABASE_URL='postgres://bad:bad@127.0.0.1:1/none' DAEMON_STARTUP_RETRY_MAX_ATTEMPTS=2 DAEMON_STARTUP_RETRY_BASE_MS=200 pnpm tsx src/main.ts start 2>&1 | head -12` from `packages/daemon`. Expect the inline-retry `unreachable` log lines (with `ECONNREFUSED`) then the `entering startup-degraded mode` line; the process then blocks polling at the 60s default cadence — Ctrl-C after confirming the lines appear. (This also exercises Task 6's degraded path.) Capture output in the commit message. Note: a clean `caused by:` chain from `formatStartupError` is observable on the *rejected* path; to see it, point at a DB that auth-fails instead (harder to reproduce locally) — the smoke above is sufficient to confirm the inline + degraded logging.

**Commit:** `daemon(main): print error.cause chain on startup failure`

---

### Task 9: Traceability + frontmatter

**Files:** `.specify/traceability.yml`, `.specify/stack/operational-safety-ts.md`.
**Dependency notes:** Blocked by 4 + 5 (files must exist).

- [ ] **Step 1.** Add to `STACK-AC-OPERATIONAL-SAFETY` `code_paths`: `packages/daemon/src/control-plane/startup-retry.ts`, `packages/daemon/src/control-plane/degraded-server.ts`. `test_paths`: their `.test.ts` siblings.
- [ ] **Step 2.** Mirror in `.specify/stack/operational-safety-ts.md` frontmatter.
- [ ] **Step 3.** `cd packages/daemon && pnpm vitest run src/infra/traceability-paths.test.ts`. 4/4 green.

**Commit:** `specs(traceability): govern startup-retry.ts + degraded-server.ts`

---

### Task 10: Full sweep

**Dependency notes:** Blocked by 1–9.

- [ ] **Step 1.** `pnpm install --prefer-offline` (worktree root).
- [ ] **Step 2.** `pnpm -r run typecheck`. Fix failures (no `@ts-ignore`).
- [ ] **Step 3.** `pnpm -r run lint`. Fix (no new eslint-disable).
- [ ] **Step 4.** `pnpm -r run test`. All green.
- [ ] **Step 5.** `cd packages/daemon && pnpm vitest run src/infra/traceability-paths.test.ts`.

**Commit only if a fix was needed.**

---

## Dependency graph

```
T1 ─┬─ T2
    └─ T3 ─┬─ T5 ─┐
T4 ────────┴──────┼─ T6 ─┬─ T7
                         └─ (T9 needs T4+T5)
T8 (independent)
T1..T9 ─ T10
```
Parallel waves: {T1, T8} → {T2, T3, T4} → {T5} → {T6} → {T7, T9} → {T10}.

## Out of Scope

Persisted last-known-good cache (option B); runtime (post-load) DB-outage resilience; launchd `KeepAlive` changes; dashboard degraded UX.

## After Implementation (Phase 8 + 9)

- One PR against `dev`: `daemon: survive transient DB outages with degraded mode + bounded retry`.
- CI green (no merge over red).
- Phase 9: `docker stop runforge-postgres-1` → observe `[daemon] startup config fetch failed (... ECONNREFUSED)` + `curl /health` → `{ ok:true, degraded:true, lastConfigError:{...} }` → `docker start ...` → observe normal startup proceeds, real `/health` returns `degraded:false`, no process restart. Capture in an execution-log PR.
