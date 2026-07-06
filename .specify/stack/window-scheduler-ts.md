---
id: STACK-AC-WINDOW-SCHEDULER
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-WINDOW-SCHEDULER
code_paths:  # pure module (Plan 1 + Plan-2 pure extensions); live registry/runtime wiring + provenance persistence is the separate integration slice
  - packages/daemon/src/session-runtime/providers/window-scheduler/types.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/headroom.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/classify.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/ledger.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/filter-rank.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/schema.ts
  - packages/daemon/src/session-runtime/providers/window-scheduler/index.ts
test_paths:
  - packages/daemon/src/session-runtime/providers/window-scheduler/**/*.test.ts
---

# STACK-AC-WINDOW-SCHEDULER — Capacity-Pool Window Scheduler (TypeScript)

## Pattern

**Ledger plus pure filter+rank, composed into `ProviderRegistry.resolve()` — never replacing it.** The scheduler is a `WindowLedger` (observed pool state) plus a pure `filterAndRankByWindow(candidates, ledgerSnapshot) → RankedCandidates` decision. It does not select, spawn, or pause; it re-orders and excludes. It plugs into the *existing* resolution seam: `resolve(binding, tier, { exclude, now })` already filters a chain by tier → health → smoke-proof and short-circuits to the first survivor (STACK-AC-SESSION-PROVIDERS). The window layer adds one more pure stage *after* tier+health filtering and *before* the short-circuit return — exhausted pools' providers are dropped, tight pools sink below ample within the same preference rank, `unknown` is treated as tight. This mirrors how Slice 2's smoke-proof gate composed: an extra eligibility predicate (`hasSmokeProof`) the scan already consulted, not a rewrite of the scan.

**Decisions are pure over a snapshot; all I/O at the edges.** Every decision function takes `(ledgerSnapshot, config, candidates, now)` and returns data — no quota probing, no Postgres, no `Date.now()` inside. Quota/rate-limit signals enter via `reportConsumption` / `reportExhaustionSignal` at the Session Runtime edge; provenance leaves via the Postgres data layer in the same persistence step as the session result. This is the lane-engine idiom (I/O at edges, exhaustively-testable decisions in the middle) applied to a stateful ledger: the ledger holds mutable observed state, but every *decision* over it is a pure function of an immutable snapshot.

**Fail-closed discriminated unions, never `null`/throw on policy questions.** Headroom is a sum type (`ample | tight | exhausted | unknown`); the classifier returns a tagged result (`window-exhaustion | provider-throttle | ambiguous`); filter+rank returns annotated candidates with a reason per drop. "Cannot decide" always maps to the cautious arm: ambiguous signal → throttle (less disruptive); no evidence → never `ample`; stale evidence → `unknown` (dispatchable, never preferred). Exceptions are reserved for programmer error, exactly as in the lane engine.

## Key Decisions

**Headroom and classification are ordered enums so cautious-wins is a `max`/`min`, not a merge.** Reuses the lane-engine escalate-only idiom: `Headroom` ordered `exhausted < unknown < tight < ample` (ranking prefers the larger; `unknown` ranks with `tight` for *eligibility* but below it for *preference*). The exhaustion-vs-throttle split (the L2's central error-handling rule) is one pure classifier — a long-horizon retry-after/quota signal marks the pool exhausted; a short-horizon throttle stays a per-provider cooldown owned by `ProviderRegistry` and never touches the pool.

```typescript
type Headroom = 'exhausted' | 'unknown' | 'tight' | 'ample';
type SignalClass =
  | { kind: 'window-exhaustion'; reopenProjection: number }
  | { kind: 'provider-throttle'; retryAfterMs: number }   // stays in ProviderRegistry cooldown
  | { kind: 'ambiguous' };                                  // → treated as provider-throttle
```

**Config is parsed once with zod into a frozen `PoolConfig`; the scheduler validates shape, not values.** Pool membership, window shape, and preference rank are config-pack data read at startup/reload (FUNC-AC-FLEET: pools and order are configuration, never platform behavior). Validation fails the config atomically on a provider mapped to zero or two pools, naming the offenders; at runtime (defense in depth) an unmapped provider becomes its own implicit single-provider pool at `unknown` with a logged warning — never a hard crash mid-dispatch.

```typescript
const PoolConfigSchema = z.object({
  name: z.string().min(1),
  providers: z.array(z.string()).nonempty(),       // every provider in exactly one pool — checked across pools
  window: z.object({ lengthMs: z.number().positive(),
    reset: z.enum(['rolling-from-first-use', 'fixed-schedule']) }),
  signalSources: z.array(z.enum(['reported-quota', 'retry-after', 'observed-throttle'])).nonempty(),
  preferenceRank: z.number().int(),
}).strict();
```

**Filter+rank composes into the existing scan via `exclude`, never a parallel resolver.** The registry stays the single source of provider selection (STACK-AC-SESSION-PROVIDERS gotcha). The scheduler annotates the candidate order the registry already built and contributes exhausted pools' provider names to the `exclude` set the failover loop in `spawnWithProviderFallback` already passes — so failover reuses the existing loop verbatim. No gate is weakened: tier, health, smoke-proof, and cooldown checks all still run; the window layer can only *remove* and *reorder*, never admit a provider the registry rejected.

**Pause-never-drop reuses the provider-unavailable pathway; reopen time is a hint, not a gate.** When filter+rank empties the candidate set, the scheduler surfaces the all-pools-exhausted condition through the *existing* `provider-unavailable` result (the L2 explicitly reuses the daemon's pause-and-auto-resume), attaching the earliest projected reopen so the pause can end at the projection rather than only on probe success. Projections are hints: an attempt is permitted once the projection passes; a provider still refusing rolls the projection forward from the new evidence instead of tight-looping. The scheduler never calls pause/resume itself — the Daemon Control Plane owns that.

**`PoolOutcomeProvenance` is written in the same persistence step as the session result, and fails closed for reviews.** Reuses the lane-engine `recordOutcome`/same-transaction idiom: provenance joins the run's recorded outcomes (fix-cycles-to-green, review rejections) on `(runId, role, modelBinding)`, so intelligence-fit per tier/task-class is computable from records alone — no re-execution. A review whose provenance cannot be persisted is reported to the Control Plane as an incomplete verification record (an unprovenanced verdict silently defeats drift detection); a non-review provenance write failure degrades filter+rank to pass-through but does not fail the session.

```typescript
type PoolOutcomeProvenance = {
  runId: string; role: string; poolName: string; providerName: string;
  modelBinding: string; windowStateAtDispatch: Headroom; recordedAt: number;
  reviewVerdictId?: string;   // set for review sessions → groups review quality per pool for drift detection
};
```

**Intelligence-fit telemetry records *fit signals*, never a cost-minimization input.** Per FUNC-AC-FLEET v2.1 the objective is the minimal capability tier that sustains the lane's quality bar. The provenance record carries the join keys; the fit metrics (`attemptsToGreen`, `reviewRejectionRate` per `tier` × `taskClass`) are *derived by consumers* from those joins, never computed or acted on here. The scheduler supplies records; it never adjusts routing — routing/tier values stay config-pack data (FUNC-AC-FLEET: never raw spend minimization, never lowering a lane's bar).

## Examples

```typescript
// Compose AFTER the registry's tier+health filter, BEFORE its short-circuit return.
function filterAndRankByWindow(
  candidates: readonly Candidate[], snap: LedgerSnapshot,
): { eligible: Candidate[]; excludePools: string[] } {
  const live = candidates.filter((c) => snap.headroom(c.pool) !== 'exhausted');
  const ranked = [...live].sort((a, b) =>            // stable within preference rank
    rankPreference(a, b) || headroomOrder(snap.headroom(b.pool)) - headroomOrder(snap.headroom(a.pool)));
  const excludePools = candidates.filter((c) => snap.headroom(c.pool) === 'exhausted').map((c) => c.pool);
  return { eligible: ranked, excludePools };       // empty eligible → caller raises provider-unavailable + reopen hint
}
```

```typescript
// The L2's central rule: long-horizon → pool exhausted; short-horizon → provider cooldown (unchanged).
function classifySignal(sig: QuotaSignal, pool: PoolConfig): SignalClass {
  if (sig.retryAfterMs >= pool.window.lengthMs * LONG_HORIZON_FRACTION || matchesWindowWording(sig))
    return { kind: 'window-exhaustion', reopenProjection: sig.observedAt + (sig.retryAfterMs ?? pool.window.lengthMs) };
  return sig.retryAfterMs > 0
    ? { kind: 'provider-throttle', retryAfterMs: sig.retryAfterMs }
    : { kind: 'ambiguous' };                          // ambiguous → treated as the less-disruptive throttle
}
```

```typescript
// Silent pool (no quota signal): estimate-only headroom caps at 'tight', never 'ample' without evidence.
function headroomFromEstimate(estimate: number, capacity: number, hasEvidence: boolean): Headroom {
  if (estimate >= capacity) return 'exhausted';
  if (!hasEvidence) return Math.min(estimate / capacity, 1) >= TIGHT_FRACTION ? 'tight' : 'tight';
  return estimate / capacity >= TIGHT_FRACTION ? 'tight' : 'ample';
}
```

## Gotchas

- **Compose into `resolve()`'s `exclude`/scan — do not build a second resolver.** The registry is the single source of provider selection. Adding window awareness means an extra pure stage and contributing exhausted pools to the existing `exclude` set, exactly as Slice 2 added `hasSmokeProof` to the scan — not a parallel resolution path that could drift from health/cooldown/smoke-proof checks.
- **A pool exhaustion excludes *all* its providers at once**, even individually-healthy ones — pool-scoped and long-horizon, disjoint from per-provider cooldown which is provider-scoped and short-horizon (ARCH-AC-SESSION-PROVIDERS). Never collapse the two into one health state.
- **`unknown` is dispatchable but never preferred.** On restart with evidence older than the pool's window length, headroom loads as `unknown`, not `ample` — assuming `ample` without evidence is the failure the L2 names. Rebuild the estimate from the first post-restart outcomes.
- **Reopen projections are hints, not gates.** Permit an attempt once the projection passes; if the provider still refuses, roll the projection forward from the *new* evidence. Never tight-loop retries against a projection, and never block an attempt the registry would otherwise allow.
- **Provenance write for a *review* fails closed; for non-reviews it degrades open.** An unprovenanced review verdict defeats drift detection, so it is reported as an incomplete verification record — but a ledger/provenance outage must not stall ordinary work: filter+rank degrades to pass-through (no pool filtering) rather than failing the spawn.
- **Spend still counts against the deployment budget whichever pool carried it.** Pool attribution composes with, never replaces, budget enforcement — exactly as fallback cost accumulates against the same run (STACK-AC-SESSION-PROVIDERS). Recording provenance is not a substitute for `recordReservedCost`.
- **Misclassification self-corrects, but only past a threshold.** Repeated immediate throttles on a pool the ledger still calls `ample` escalate to `exhausted` after the configured repetition count — do not flip a pool exhausted on a single ambiguous signal, and do not let a stuck-`ample` pool absorb work forever.
- **Telemetry records fit signals, never a cost knob.** Do not add a code path that reads `attemptsToGreen`/`reviewRejectionRate` to re-route or down-tier; the scheduler writes records, consumers analyze them, and tier/routing values remain config-pack data (FUNC-AC-FLEET v2.1).

## Concerns This Spec Does Not Cover

- Provider selection, per-provider health/cooldown, smoke-proof admission, and the resolution chain (STACK-AC-SESSION-PROVIDERS / ARCH-AC-SESSION-PROVIDERS own these; this spec only filters and re-ranks their output).
- Pausing, resuming, and spawning sessions (Daemon Control Plane / Session Runtime); the scheduler only surfaces all-pools-exhausted through the existing provider-unavailable pathway with a reopen hint.
- Per-deployment budget enforcement and cost accounting (Session Runtime cost layer); pool attribution composes with it and never replaces it.
- The fit-metric *analysis* itself — attempts-to-green/review-rejection roll-ups, overshoot/undershoot surfacing, and any routing-config recommendation (telemetry / tech-lead consumers); this spec only emits the records they read.
- Interpreting review *content* or changing preference ranks (configuration and analysis consumers own these; the scheduler stamps provenance and reads config, it never authors either).
- The config-pack loading/versioning/activation lifecycle (FUNC-AC-PLUGINS chain); this spec consumes a parsed, validated `PoolConfig`.
