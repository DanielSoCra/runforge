---
id: STACK-AC-OPERATIONAL-SAFETY
type: stack-specific
domain: auto-claude
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
  - packages/daemon/src/control-plane/pipeline.ts
  - packages/daemon/src/data/config-reader.ts
test_paths:
  - packages/daemon/src/session-runtime/cost.test.ts
  - packages/daemon/src/session-runtime/rate-limiter.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
  - packages/daemon/src/session-runtime/session-error.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/control-plane/pipeline.test.ts
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
