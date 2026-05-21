# Daemon DB-Outage Resilience — Design

Date: 2026-05-21
Status: draft (pending spec deep-review)
Spec refs: FUNC-AC-SAFETY, FUNC-AC-DATA-PLATFORM, ARCH-AC-OPERATIONAL-SAFETY, ARCH-AC-DATA-PLATFORM, STACK-AC-OPERATIONAL-SAFETY, STACK-AC-DATA-PLATFORM

## Goal

The auto-claude daemon should survive a transient operational-data outage (Postgres unreachable) without exiting the process, surface the underlying cause of dependency failures in operator-readable form, and still fail loudly on permanent misconfiguration (schema/auth/permission errors).

## Current State

- `packages/daemon/src/control-plane/daemon.ts:201` calls `await configReader.start()`, which calls `await this.fetch()` once in `packages/daemon/src/data/config-reader.ts:38`. Any throw bubbles to `main.ts:18`, which `process.exit(1)`s.
- launchd (`scripts/com.autoclaude.daemon.plist`) keeps the process alive via `KeepAlive` + `ThrottleInterval=30`. Result: a Postgres outage produces an opaque crash-loop with no `/health` reachable.
- Today's incident: Docker was stopped; the heartbeat went stale; the log filled with `Failed to start: [config-reader] global settings fetch failed: Failed query: select "id", ... from "global_settings"` — no indication that the actual cause was `ECONNREFUSED`.
- `unavailableOnThrow()` in `packages/db/src/postgres-stores.ts:861` catches every Drizzle error and reduces it to `error.message`. `postgres-js` wraps connection errors so the `message` is the SQL only; the underlying `cause` (`ECONNREFUSED`, `28P01`, `42P01`) is dropped on the floor.
- The control HTTP server (`createControlServer` in `packages/daemon/src/control-plane/server.ts:180`) does not bind until step 6 of `startDaemon` — *after* the failing step-2 config fetch. The observability surface is unavailable exactly when it would be most useful.

## Design — bounded retry + degraded background-retry (option E)

Sparring with codex picked option E over: A (bounded retry then exit), B (last-known-good disk cache bootstrap), C (server-first, no inline retry), D (diagnostic-only). Rationale carried in the codex transcript; in short: A still hands recovery to launchd (silent crash-loop), C hides the boot-race vs real-outage distinction, B adds correctness risk around stale repo sets / schema drift, D fixes the visibility gap but leaves the process exiting needlessly.

### Behavioral contract

1. **Categorical store outcomes.** Every `StoreResult` failure of error `unavailable` now carries a `category` of `unreachable` (transient, retry-eligible) or `rejected` (permanent — schema, auth, syntax, permission). Consumers branch on category, not on message text.
2. **Cause preservation.** `unavailableOnThrow()` walks `error.cause` and picks the **deepest** layer that has a non-empty `code` or non-default `name`/`class`; if every layer is opaque, the outermost `message` is used. The chosen layer is recorded as `{ class, code, message }` on the unavailable result, and the human-readable message becomes `${SQL summary} — ${code}: ${chosen-layer message}` rather than only the SQL. The rule is shared verbatim with STACK-AC-DATA-PLATFORM.
3. **Server-first startup.** `startDaemon()` reorders so the control HTTP server starts immediately after the data-layer client (instance lock acquired) but *before* the first `configReader.fetch()`. `startupDegraded = true` is the initial flag — the observability surface answers from t=0 with `{ degraded: true }`. The flag clears the moment the first successful fetch lands (whether inline or background).
4. **Bounded inline retry.** Initial config fetch retries up to 5 attempts with backoff `1s, 2s, 4s, 8s, 16s` (~31s total). Each attempt logs `[daemon] startup config fetch failed (attempt N/5, ${category}, ${code}): ${message}`. Tunable via `DAEMON_STARTUP_RETRY_MAX_ATTEMPTS`, `DAEMON_STARTUP_RETRY_BASE_MS`, `DAEMON_STARTUP_RETRY_MAX_DELAY_MS`. **Inline attempts do not advance the escalation counter** — they are the daemon's fast-recovery path for boot races against Docker startup.
5. **Background-retry phase.** If all inline attempts fail with `unreachable`, the daemon stays in `startupDegraded` and starts a background timer (existing config poll cadence) that calls `tryFetch()` repeatedly. First success clears the flag. The work-claim loop refuses to claim while `startupDegraded === true`. Background-retry attempts (and only background-retry attempts) advance the escalation counter described in (7).
6. **Categorical `rejected` → fail loud (any phase).** If any attempt returns `category: 'rejected'`, the daemon fails loudly. In the inline phase this means short-circuit the retry loop and `startDaemon()` returns `err(...)` (then `main.ts` exits non-zero). In the background phase `startDaemon` has already resolved, so the background timer's `rejected` outcome logs the underlying reason and calls `process.exit(1)` directly. Permanent misconfiguration is never silently retried regardless of phase. The escalation counter is irrelevant for `rejected` outcomes — they always exit on first detection.
7. **Escalation.** A counter tracks consecutive unrecovered background-retry attempts while `startupDegraded === true`. The threshold is the **existing** `config.maxConsecutiveStuck` value reused verbatim — no new threshold field is introduced. Once the counter reaches that threshold the daemon fires a single Operator notification on the configured channel and does not re-fire until the degraded flag has cleared at least once (tracked via a `notifiedThisDegradation` boolean reset on clear).

### Rejected alternatives

- **Persisted last-known-good config (option B).** Adds correctness risk: repo list might be stale, plugin set might be stale, daemon might claim work against a config that no longer reflects the operator's truth. Defer until we have a forcing function.
- **Skip the inline-retry, go straight to degraded (option C).** A fresh boot-race against Docker startup almost always recovers within 5–10s; making every Mac mini boot read `degraded` for the first poll interval is noisy and degrades the signal value of `/health.degraded`.
- **Walk back to launchd as the sole recovery loop (option A).** Hours of opaque crash-loop on a dependency outage is exactly the failure mode this incident exposed; we should not leave it intact.

### Integration details

- **Concurrency.** The background-retry timer must use the existing `setInterval`/`fetchSafe` machinery (no new ticker). Reusing the timer means the daemon's existing `stop()` / drain semantics teardown the retry naturally — no separate lifecycle.
- **Phase boundary, not race.** Inline-retry and background-retry are mutually exclusive phases: the background timer is only armed *after* the inline retry has been awaited to completion (exhausted with `unreachable` outcomes). There is no overlap window. The flag is set/cleared via a single private setter on `PostgresConfigReader` to keep the code simple, but mutual exclusion comes from the phase-boundary contract, not from concurrency primitives.
- **Existing `fetchSafe` warning.** Keep `console.warn` for steady-state polling failures; route startup-degraded failures through a distinct log prefix (`[daemon] startup config fetch failed`) so log greps can distinguish them.
- **Workspace lock.** Instance lock comes from the control port `listen()` (see `packages/daemon/src/control-plane/server.ts:180`). Server-first startup acquires the lock earlier, but does not change lock semantics — still "only one daemon per port."
- **Mutation refusal.** All write/spawn paths (`tryClaimWork`, `processRun`, anything calling `configReader.getGlobalConfig()` to make a budget decision) must consult `daemon.startupDegraded` and short-circuit. Existing `paused` / `draining` flag pattern is the closest analogue — extend it.
- **`docker-compose.yml depends_on: daemon`.** Only `briefing-summarizer`'s `depends_on` lists `migrate`; nothing depends on `daemon`. Server-first startup does not change dashboard-side reachability.

### File topology

**Modified**

- `packages/db/src/postgres-stores.ts` — `unavailableOnThrow` walks `error.cause`; `errorMessage` formats `code:class:message`. Add `category: 'unreachable' | 'rejected'` field on the unavailable result type. Classification helper distinguishes network/timeout (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`) from postgres SQLSTATE classes (`08*` connection — unreachable; `28*` auth, `42*` syntax/schema — rejected).
- `packages/db/src/stores.ts` — extend `StoreResult` `unavailable` variant with `category` and structured `cause`.
- `packages/daemon/src/data/config-reader.ts` — split `fetch()` and `start()`: add `tryFetch(): Promise<Result<void, ConfigFetchError>>` returning typed failures; add `startBackgroundRetry()` for the post-bounded-retry phase; `start()` becomes the orchestrator used by `startDaemon`.
- `packages/daemon/src/control-plane/daemon.ts` — reorder startup so `createControlServer().start()` runs before the bounded retry; thread `startupDegraded` flag through to status/health responses; add work-claim guard. (Governed by STACK-AC-OPERATIONAL-SAFETY + STACK-AC-CONTROL-PLANE; already listed in both.)
- `packages/daemon/src/control-plane/server.ts` — `/status` and `/health` include `{ degraded, lastConfigError }` when degraded. (Governed by STACK-AC-CONTROL-PLANE's glob `packages/daemon/src/control-plane/`; status/health shape is a control-plane surface concern, no STACK-AC-OPERATIONAL-SAFETY addition required.)
- `packages/daemon/src/main.ts` — surface non-Error throws with full cause chain. (Governed by STACK-AC-CONVENTIONS and STACK-AC-RUNTIME-SOURCE-ISOLATION via their explicit `main.ts` entries; not added to STACK-AC-OPERATIONAL-SAFETY because the change is process-boundary error formatting, not safety semantics. STACK-AC-CONTROL-PLANE does *not* govern `main.ts`.)

**New**

- `packages/db/src/error-classification.ts` (or co-located in `postgres-stores.ts`) — `classifyDriverError(err): { category, code, class, message }`. (Governed by STACK-AC-DATA-PLATFORM's glob `packages/db/**`; will be added to traceability literal list in the implementation PR.)
- `packages/daemon/src/control-plane/startup-retry.ts` — bounded-retry helper with injectable `delay` for tests. (Governed by STACK-AC-OPERATIONAL-SAFETY + STACK-AC-CONTROL-PLANE; will be added to both `code_paths` literal lists in the implementation PR alongside its `.test.ts` sibling. Not added now to keep the spec PR green against `traceability-paths.test.ts`.)

**Explicitly unchanged**

- `scripts/com.autoclaude.daemon.plist` — `KeepAlive` + `ThrottleInterval=30` stay as backstop for true crashes (process death, OOM). Not the primary recovery mechanism anymore.
- `packages/daemon/src/data/postgres-config-reader.test.ts` (if present) — extend, don't replace; existing semantics preserved.

### Test strategy

- **Unit, `unavailableOnThrow` classification.** Synthetic errors for each SQLSTATE (`08006`, `28P01`, `42P01`, `42703`) and each network errno (`ECONNREFUSED`, `ETIMEDOUT`); assert `category` and `cause.code` round-trip.
- **Unit, `startup-retry`.** Inject fake `tryFetch` that fails `unreachable` N times then succeeds; assert max attempts, backoff sequence, flag transitions. Inject `rejected` failure on attempt 1; assert short-circuit.
- **Unit, `config-reader.startBackgroundRetry`.** Fake clock; assert poll cadence, flag clearing on first success, escalation counter increment + notification one-shot.
- **Integration, daemon.test.ts.** Mock data layer to return `unreachable` for first N polls; assert `/health` reports degraded, `tryClaimWork` returns refused, then asserts recovery once the mock starts returning ok.
- **End-to-end (Phase 9, manual).** `docker stop auto-claude-postgres-1`; observe `[daemon] startup config fetch failed (attempt 1/5, unreachable, ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:5432` in the log; observe `/health` returns `{ ok: true, degraded: true, lastConfigError: { ... } }`; `docker start auto-claude-postgres-1`; observe degraded clears within one poll interval, no process restart.

### Risks

- **Test runtime.** Bounded retry with real delays would inflate test runtime. Inject `delay` via parameter; default to `setTimeout`, override to immediate in tests.
- **Notification spam.** If degraded oscillates (postgres flapping), the escalation one-shot must only re-arm after a clean cycle (degraded cleared at least once). Track via a separate `notifiedThisDegradation` boolean reset when the flag clears.
- **Refused-work observability.** Operators may see "0 work claimed" without knowing why. The `/status` response already exposes `paused` / `draining`; adding `degraded` to the same payload keeps the diagnostic surface in one place.
- **`process.uncaughtException` and the early HTTP server.** Starting the server before the config fetch means an unhandled rejection in the retry loop could leave the server bound and the process alive but useless. Wrap `startupRetry()` in a `try/catch` that always either treats a `rejected` outcome as terminal cleanup (log the underlying reason, call `process.exit(1)` — do NOT clear `startupDegraded` first, since a transient "not degraded" status visible right before exit would confuse `/health` consumers), or transitions to background retry. No silent dangling state.

### Follow-ups (intentionally out of scope)

- Persisted last-known-good cache (option B). Revisit only if degraded-only startup is too limited in practice (e.g., dashboard wants to read repo list from daemon while it's degraded).
- Generalising the same retry-and-degrade pattern to runtime DB outages, not just startup. The existing `fetchSafe` already caches; this is mostly a notification concern (currently `console.warn` only).
- Removing `KeepAlive` from launchd entirely once we trust the self-healing. Premature.

### Migration plan

Single PR against `dev`. No data migration; only behavior change inside the daemon process. Rollback is `git revert` on the merge commit — the old crash-loop behavior returns and Docker-up is again the manual recovery.
