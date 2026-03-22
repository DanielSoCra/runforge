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
test_paths:
  - packages/daemon/src/session-runtime/cost.test.ts
  - packages/daemon/src/session-runtime/rate-limiter.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
  - packages/daemon/src/control-plane/daemon.test.ts
  - packages/daemon/src/control-plane/pipeline.test.ts
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

## Gotchas

- `SessionError.cost` must always be populated. A zero-cost error is valid (e.g., rejected before spawn); a missing cost field is a bug. The Daemon's cost recording path must handle both `SessionResult` and `SessionError` without branching on type.
- The `consecutiveStuckCount` resets on ANY non-stuck outcome, including `paused`. This is intentional — a budget pause is not the same failure mode as consecutive stuck runs, and should not contribute to the auto-pause threshold.
- Rate limit cooldown is passive (checked on next spawn attempt), not active (no timer fires). This means the Daemon must attempt a spawn to discover that the cooldown has expired. The polling loop's natural interval handles this — no separate "check cooldown" tick is needed.
- `shuttingDown` and `paused` are separate flags. `shuttingDown` is irreversible within a process lifetime (the daemon is exiting). `paused` is reversible via the `/resume` endpoint. Both prevent new work claims, but only `paused` can be cleared.
- The port-based instance lock means a crashed daemon may hold the port in TIME_WAIT for ~60 seconds. Set `SO_REUSEADDR` on the server socket to allow immediate restart. See STACK-AC-CONTROL-PLANE for the pattern.
- Budget signals use `PhaseEvent` union types (`'budget-exceeded'`, `'per-run-budget-exceeded'`, `'rate-limited'`). Adding a new signal requires updating the `PhaseEvent` type, the pipeline's `applyGlobalTransition()`, and the Daemon's signal-handling switch. All three must stay in sync.
