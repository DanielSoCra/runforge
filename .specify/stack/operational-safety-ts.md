---
id: STACK-AC-OPERATIONAL-SAFETY
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-OPERATIONAL-SAFETY
code_paths:
  - packages/daemon/src/session-runtime/cost.ts
  - packages/daemon/src/session-runtime/rate-limiter.ts
  - packages/daemon/src/session-runtime/runtime.ts
  - packages/daemon/src/session-runtime/session-error.ts
  - packages/daemon/src/control-plane/daemon.ts
  - packages/daemon/src/control-plane/watchdog.ts
  - packages/daemon/src/control-plane/health.ts
  - packages/daemon/src/control-plane/crash-handlers.ts
  - packages/daemon/src/control-plane/pipeline.ts
  - packages/daemon/src/control-plane/startup-retry.ts
  - packages/daemon/src/control-plane/degraded-server.ts
  - packages/daemon/src/data/config-reader.ts
test_paths:
  - packages/daemon/src/session-runtime/cost.test.ts
  - packages/daemon/src/session-runtime/rate-limiter.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
  - packages/daemon/src/session-runtime/session-error.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/control-plane/watchdog.test.ts
  - packages/daemon/src/control-plane/health.test.ts
  - packages/daemon/src/control-plane/crash-handlers.test.ts
  - packages/daemon/src/control-plane/first-use-safety-net.test.ts
  - packages/daemon/src/control-plane/pipeline.test.ts
  - packages/daemon/src/control-plane/startup-retry.test.ts
  - packages/daemon/src/control-plane/degraded-server.test.ts
  - packages/daemon/src/data/config-reader.test.ts
---

# STACK-AC-OPERATIONAL-SAFETY — Operational Safety Coordination (TypeScript)

## Pattern

**Signal-based coordination between Session Runtime and Daemon Control Plane.** Cross-service safety contracts are implemented as typed return values and flag fields on shared types — not as event emitters, message queues, or RPC calls. The Session Runtime returns `SessionError` objects with signal flags (`rateLimited`, `containmentBreach`, `cost`); the Daemon Control Plane reads these flags and transitions pipeline state accordingly. This keeps the contract surface small and testable.

**Independent circuit breakers at three budget levels.** Cost control uses three independent mechanisms that share no state: the `CostTracker` class enforces daily and per-run budgets, the session process enforces its own per-session cap, and the Daemon Control Plane acts on budget-exceeded signals by pausing or transitioning runs to stuck. A bug in one mechanism does not disable the others.

**Fail-safe defaults via guard clauses.** Every safety-critical decision point (spawn, phase transition, budget check) starts with a guard clause that rejects the operation if safety state is unknown or ambiguous. The pattern is: check before acting, never act then check.

## Key Decisions

**Budget signal: Typed return value, not event.** `SessionRuntime.spawnSession()` returns a `SessionResult` on success or a `SessionError` carrying the `cost` field (always populated, even on failure) plus signal flags. The Daemon Control Plane calls `pipeline.applyGlobalTransition('budget-exceeded')` or `applyGlobalTransition('per-run-budget-exceeded')` based on the flag. Chosen over event emitters because the caller already awaits the result — adding an event channel would create two paths for the same information.

**Rate limit signal: Flag on SessionError + RateLimiter state.** When `spawnSession()` detects a rate limit response, it calls `rateLimiter.reportRateLimit()` (which manages escalating backoff) and returns a `SessionError` with `rateLimited: true`. The Daemon Control Plane reads this flag and stops claiming new work. On subsequent spawn attempts, `spawnSession()` checks `rateLimiter.isLimited()` and returns early with a rate-limited `SessionError` without hitting the upstream provider. Cooldown expiry is passive — `isLimited()` checks `Date.now() < cooldownUntil`.

**Containment breach signal: Flag on SessionError, terminal for the run.** Post-session audit (`auditSessionOutput()`) detects prohibited path references in session output. If violations are found, `spawnSession()` returns a `SessionError` with `containmentBreach: true`. The Daemon Control Plane transitions the run to `stuck` with a containment breach note. The run cannot proceed regardless of remaining retry budget — this is enforced by the pipeline's global transition logic.

**Consecutive failure tracking: Counter in Daemon.** The Daemon maintains `consecutiveStuckCount` as a plain number. Incremented when a work request ends in `stuck`; reset to zero on any non-stuck outcome. When the count reaches `config.maxConsecutiveStuck`, the daemon auto-pauses and sends a webhook notification. Chosen over a ring buffer or time-windowed approach because the L1 spec defines the trigger as "consecutive" — ordering matters, not frequency.

**Graceful shutdown: Flag + signal cascade.** The Daemon sets `shuttingDown = true` on SIGTERM/SIGINT, which prevents the polling loop from claiming new work. Active runs complete naturally up to the grace period. After the grace period, the Daemon calls `remoteControl.stop()` (SIGTERM to subprocess), flushes run state via `writeJsonSafe()`, and closes the HTTP server to release the port lock. The `finally` block in the run loop ensures `notifyRunEnd()` always fires, even on crash.

**Cost tracking persistence across errors.** `SessionError` always carries the `cost` field. The Daemon records cost from both successful results and errors — cost accrues regardless of outcome. This prevents a failure mode where errored sessions consume budget but don't report it.

**Pause cause is a tagged field, not inferred (B4).** A `pauseReason` (`'manual' | 'budget' | 'stuck' | 'tick-error' | 'runtime-source'`) is stamped at *every* `paused = true` site alongside the flag (the operator `pause()` handler → `'manual'`; daily-budget → `'budget'`; consecutive-stuck → `'stuck'`; coordinator tick-error threshold → `'tick-error'`; runtime-source preflight → `'runtime-source'`; the watchdog → `'stuck'`) and cleared on `resume()`. `/health` reads it to distinguish an *intentional* manual pause (200 degraded) from a *safety* pause (503). An un-tagged pause (defensive default) is treated as a safety pause. Co-locating the assignment with the existing `paused = true` keeps the set of sites auditable.

**Alert delivery is centralized so the empty-channel case is never silent (B1/B2).** A single `notifyOperator(payload)` closure replaces ad-hoc `void notify(config.webhooks, …)` at the auto-pause sites: when `hasConfiguredAlertChannel(config)` is false it emits a structured `console.warn` instead of the silent no-op; otherwise it forwards to `notify` and records whether the send failed (a transient-failure signal for `/health`). At boot a governed deployment (`config.deployment !== undefined`) with no channel sets a persistent `alertChannelDegraded` flag + a loud warning — but does **not** refuse boot (warn-not-refuse; the hard-refuse `B2-strict` is deferred). `hasConfiguredAlertChannel` is the one abstraction over the raw `webhooks` array.

**Truthful `/health` is a pure evaluator fed a state snapshot (B4).** `evaluateHealth(signals): { ok, degraded, reason }` (`control-plane/health.ts`) is a side-effect-free function mapping a `HealthSignals` snapshot onto 503 / 200-degraded / 200-ok; the daemon's `getHealth` handler gathers the snapshot (pause + cause, draining, stuck count, watchdog stall, governed index runtime-degraded/enabled-but-unavailable, startup-degraded, alert-channel-degraded, transient alert failure, repo-tick-stale) and delegates the decision. The control server (`server.ts`) maps the result onto the HTTP status code and adds the 200-`degraded:true` branch. Keeping the matrix pure makes it exhaustively unit-testable without booting the daemon; the governed-index signal is scoped to governed deployments only (a non-governed daemon's index state is never a health signal — preserves the PR1 behavior).

**Work-loop watchdog is detect-only and structurally cannot release the slot (B5).** `control-plane/watchdog.ts` exposes a pure `evaluateWatchdog(signals, now, idleTimeoutMs)` (returns the first run-stall or tick-stall, strictly-greater-than the timeout; a null progress timestamp is never a stall) and a `createWatchdog(deps)` factory whose `tick()` no-ops while shutting down/draining or already paused, else reads live signals and invokes `onStall`. Run progress is read via `readActiveRunProgress(activeIssues, loadRunState)` — each active issue's persisted `updatedAt` (no new in-memory registry to keep in sync, since `saveRunState` already persists it on every progress write); poll liveness via `RepoManager.pollerSnapshot()` (`pollStartedAt` added to each entry, injectable clock). The daemon's `onStall` self-pauses (`pauseReason='stuck'`), records the stall, and notifies once — and **has no access to the active-run count**, so the "never decrement `activeRuns` / never cancel" safety property is structural, not a discipline. The clock + idle-timeout + signal reader are injectable via `StartDaemonOptions.watchdog` for deterministic fake-timer tests.

**Top-level crash handlers built as a pure factory and wired inside `startDaemon` (T2.7).** `createCrashHandlers({ notifyOperator, shutdown, setExitCode })` (`control-plane/crash-handlers.ts`) returns `onUncaughtException` / `onUnhandledRejection` that notify, set exit code 1, and drain — with a re-entrancy latch so a crash mid-drain does not restart-storm. They are registered with `process.on(...)` **inside** `startDaemon` after config load (where the alert channel + the private drain are in scope), NOT in `main.ts`. The factory shape makes the behavior unit-testable without registering real listeners.

**Startup configuration load: throwaway degraded server + bounded retry + blocking recovery.** Rather than reorder the large, tightly-coupled `startDaemon` body, bind a *throwaway* minimal observability server (`createDegradedServer`, answering only `/health` + `/status` with `{ ok: true, degraded: true, lastConfigError }`) on the control port immediately after the DB client + `configReader` are constructed, before any DB I/O. Then run a bounded inline retry of `configReader.tryFetch()` (default 5 attempts; backoff after attempts 1–4 of `1s, 2s, 4s, 8s` — no delay after the final attempt; env-tunable via `DAEMON_STARTUP_RETRY_MAX_ATTEMPTS` / `_BASE_MS` / `_MAX_DELAY_MS`). Inline attempts do **not** advance the escalation counter. On inline exhaustion, `startDaemon` `await`s `runDegradedUntilRecovered(...)`, a loop that polls `tryFetch()` at the config cadence and resolves only on success; while it blocks, the throwaway server keeps `/health` reachable. The first successful fetch (inline or background) resolves the await, the daemon `await degraded.handle.close()`s (releasing the port), and the **unchanged** normal startup runs linearly — re-binding the real control server at its original place. There is no recovery callback and no `completeStartup` extraction: the heavy startup body runs exactly once, after config is loaded, with its `Result` propagated normally. A categorical `rejected` Store outcome on **any** attempt is fatal: inline `rejected` → close degraded server, end DB client, `return err(...)`; background `rejected` → close degraded server, end DB client, `process.exit(1)` (startDaemon is blocked in the await and will not return). Degraded mode is for `unreachable` only. `runDegradedUntilRecovered` counts unrecovered `unreachable` polls against `config.maxConsecutiveStuck` (the existing `>=` comparator; no new threshold field) and fires a one-shot operator notification at the threshold, re-armed only after a clean recovery (`notifiedThisDegradation`). Because no work loop, crash-resume, or parked-resume is wired until the post-block normal startup, the daemon structurally cannot claim work while degraded.

## Examples

```typescript
// Budget guard clause before spawn — fail-safe default
const budget = costTracker.checkBudget(runId);
if (budget === 'daily-budget-exceeded') {
  return SessionError.budgetExceeded(budget);
}
```

```typescript
// Rate limit signal flow — return value, not event
const result = await adapter.spawn(def, ctx);
if (result.rateLimited) {
  rateLimiter.reportRateLimit(result.retryAfterMs);
  return SessionError.rateLimited(result.cost);
}
```

```typescript
// Consecutive stuck tracking — plain counter
if (outcome === 'stuck') {
  consecutiveStuckCount++;
  if (consecutiveStuckCount >= config.maxConsecutiveStuck) {
    paused = true;
    await notify({ event: 'auto-paused', reason: 'consecutive-stuck' });
  }
} else {
  consecutiveStuckCount = 0;
}
```

```typescript
// Global transition — containment breach is terminal
applyGlobalTransition(event: PhaseEvent): Phase | null {
  if (event === 'containment-breach') return 'stuck';
  if (event === 'budget-exceeded') return 'paused';
}
```

```typescript
// Throwaway degraded server up first, then bounded retry, then LINEAR normal startup.
const degraded = createDegradedServer(port, host, () => degradedState);
await degraded.start();
const result = await runStartupRetry(() => configReader.tryFetch(), opts, onAttempt);
if (result.kind === 'rejected') { await degraded.handle.close(); await pg.sql.end(); return err(...); }
if (result.kind === 'exhausted') { await runDegradedUntilRecovered(configReader, degradedState, ...); }
await degraded.handle.close();          // hand the port to the real server
// ── existing startDaemon body runs UNCHANGED from here (configReader.start() is now timer-only) ──
```

## Gotchas

- `SessionError.cost` must always be populated. A zero-cost error is valid (e.g., rejected before spawn); a missing cost field is a bug. The Daemon's cost recording path must handle both `SessionResult` and `SessionError` without branching on type.
- The `consecutiveStuckCount` resets on ANY non-stuck outcome, including `paused`. This is intentional — a budget pause is not the same failure mode as consecutive stuck runs, and should not contribute to the auto-pause threshold.
- Rate limit cooldown is passive (checked on next spawn attempt), not active (no timer fires). This means the Daemon must attempt a spawn to discover that the cooldown has expired. The polling loop's natural interval handles this — no separate "check cooldown" tick is needed.
- `shuttingDown` and `paused` are separate flags. `shuttingDown` is irreversible within a process lifetime (the daemon is exiting). `paused` is reversible via the `/resume` endpoint. Both prevent new work claims, but only `paused` can be cleared.
- The port-based instance lock means a crashed daemon may hold the port in TIME_WAIT for ~60 seconds. Set `SO_REUSEADDR` on the server socket to allow immediate restart. See STACK-AC-CONTROL-PLANE for the pattern.
- Budget signals use `PhaseEvent` union types (`'budget-exceeded'`, `'per-run-budget-exceeded'`, `'rate-limited'`). Adding a new signal requires updating the `PhaseEvent` type, the pipeline's `applyGlobalTransition()`, and the Daemon's signal-handling switch. All three must stay in sync.
- **The degraded server and the real server must never listen simultaneously.** The throwaway server holds the control port during the outage; `await degraded.handle.close()` (which drains in-flight requests and releases the listener) must complete before the normal startup binds the real server on the same port. Sequential `await` on the single-threaded event loop makes the close→bind handoff safe; if `close()` ever hangs, the real bind fails `EADDRINUSE` → `startDaemon` returns err → launchd respawns (acceptable).
- **`start()` must become timer-only.** Once the bounded inline retry (or background recovery) has loaded config via `tryFetch`, the existing `configReader.start()` call in the normal startup body must NOT issue another initial fetch — otherwise a DB blip in the handoff window would throw and abort startup. Strip the `await this.fetch()` from `start()`; keep only the `setInterval`.
- **Don't retry-and-degrade on categorical `rejected` errors.** A schema-missing or auth-failed result must short-circuit and exit with the underlying reason (inline → `err`, background → `process.exit(1)` after cleanup). Otherwise a permanent misconfiguration looks identical to a transient outage and silently consumes hours.
- **Mutation refusal is structural in this design, not a guard.** Because the work loop / crash-resume / parked-resume are wired only in the post-degraded normal startup, the daemon cannot claim work while degraded. A one-line `isStartupDegraded()` check on the work-detection callback is cheap belt-and-suspenders but is not the load-bearing mechanism.
- **The watchdog does NOT recover the held slot.** A detected stall self-pauses + alerts + flips `/health` to 503, but the hung run's concurrency slot stays held until Operator restart — `activeRuns` decrements only in the run promise's `.finally()`, which a non-settling orchestration await may never reach. This is the intended honest scope: the "goes dark" gap is closed (visible + no new work), but force-cancelling the run is the deferred **B5-cancel** follow-up. Do not "fix" this by decrementing `activeRuns` in the watchdog (double-decrement / overlapping-work / zombie-mutation hazard).
- **The watchdog idle-timeout must stay above the longest bounded in-worker phase.** Default = 3h subprocess-kill bound + 15m grace, so a long-but-*progressing* worker phase never false-positives (its `updatedAt` keeps advancing). `config.watchdogIdleTimeoutMs` is configurable **downward only** — the daemon clamps it with `Math.min(config.watchdogIdleTimeoutMs ?? DEFAULT, DEFAULT)` so a config can tighten it for a watched pilot but can never *raise* it above the default and silently weaken the safety net. (The test seam `opts.watchdog.idleTimeoutMs` is unclamped for deterministic fake-timer tests.)
- **`/health`'s `repoTickStale` 503 must use the watchdog idle-timeout, not an earlier multiple of the poll interval.** A poll legitimately awaits `preClassifyReadyWork` (the batch-classifier session, capped at the 3h subprocess timeout), so an early threshold (e.g. `3 × pollIntervalMs ≈ 90s`) would false-503 a healthy long classifier run. The `repoTickStale` read is aligned to `watchdogIdleTimeoutMs` so it can never disagree with the tick-stall watchdog — it is just an on-demand read of the same condition that lets `/health` report 503 before the watchdog's next interval tick.
- **The fatal crash handler must be BOUNDED — and its `shutdown` dep must resolve only on ACTUAL completion.** `createCrashHandlers` notifies + sets exit code 1 + attempts a graceful drain, and also schedules an **unref'd** force-exit timer (`DEFAULT_FATAL_DRAIN_TIMEOUT_MS`). Critically, the daemon must NOT wire `shutdown` to `enterDrainMode()` directly: `enterDrainMode()` returns **immediately** when `activeRuns>0` (it only flips the `draining` flag and stops schedulers), so awaiting it would exit instantly — defeating both the clean-completion wait and the bounded timer. Instead the daemon passes `() => { void enterDrainMode(); return shutdownComplete; }`, where `shutdownComplete` is a deferred resolved at the END of the real `shutdown()`. Net behavior: a clean active run drains then exits; an idle daemon exits promptly; a WEDGED run leaves `shutdownComplete` pending so the unref'd timer force-exits at the bound. An exit-once latch makes the drain-settled path and the timer path exit exactly once.
- **The drain-completion trigger must run AFTER the `activeRuns` decrement.** `handleRunOutcome`'s `if (draining && activeRuns === 0)` check runs in the run promise's `.then`, BEFORE the `.finally` decrement, so for the FINAL in-flight run it sees `activeRuns>0` and never completes the drain. The decrement is funnelled through a single `finishActiveRun()` helper (`activeRuns--` + the post-decrement `if (draining && activeRuns === 0 && !shuttingDown) void shutdown()`), called at every run-settle `.finally`, so the last run reliably finishes the drain and resolves `shutdownComplete`.
- **An un-tagged `paused` must read as a *safety* pause (503), not degraded.** If a new pause site is added without a `pauseReason`, `evaluateHealth` deliberately treats `pauseReason === null` as the cautious 503 case — so a missed stamp fails *safe* (over-reports unhealthy) rather than silently masking a real stall as an intentional pause.
- **Deferred (NOT built here, do not implement without an Operator L1 decision):** `B2-strict` (hard-refuse boot when a governed deployment has no alert channel), `B5-cancel` (watchdog force-cancellation of a hung run), and `B3` (outbound dead-man's-switch to an external monitor). Until `B3`, unattended liveness depends on the documented ops prerequisite that an external monitor polls `/health` (see `docs/running.md`).
