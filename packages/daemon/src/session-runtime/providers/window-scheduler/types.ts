// packages/daemon/src/session-runtime/providers/window-scheduler/types.ts

/**
 * Headroom is a fail-closed ordered enum (cf. lane-engine RiskLevel): cautious
 * states sort low so "prefer the larger headroom" is a plain numeric comparison.
 * Ordered exhausted < unknown < tight < ample (see HEADROOM_ORDER).
 *
 *  - exhausted: pool's window is spent; all its providers are dropped.
 *  - unknown:   no/stale evidence. Dispatchable (ranks WITH tight for eligibility)
 *               but never preferred (ranks BELOW tight for preference). Never auto-ample.
 *  - tight:     evidence says capacity is low but usable.
 *  - ample:     evidence says capacity is plentiful. Only reachable WITH evidence.
 */
export type Headroom = 'exhausted' | 'unknown' | 'tight' | 'ample';

/**
 * Result of classifying one quota/rate-limit signal. The L2's central
 * error-handling rule: long-horizon → pool exhausted; short-horizon → per-provider
 * cooldown (owned by ProviderRegistry, never marks the pool); cannot-decide →
 * ambiguous, which consumers MUST treat as the less-disruptive provider-throttle.
 */
export type SignalClass =
  | { kind: 'window-exhaustion'; reopenProjection: number }
  | { kind: 'provider-throttle'; retryAfterMs: number } // stays in ProviderRegistry cooldown
  | { kind: 'ambiguous' }; // → consumers map to provider-throttle (less disruptive)

/**
 * A quota/rate-limit signal observed in a provider response, fed in at the
 * Session Runtime edge. `retryAfterMs` may be 0/absent (→ ambiguous). `observedAt`
 * is the wall-clock time the signal was seen (passed in, never read from a clock here).
 */
export interface QuotaSignal {
  providerName: string;
  retryAfterMs?: number;
  observedAt: number;
  /** Optional provider wording that positively indicates the recurring window. */
  windowWording?: boolean;
  /**
   * Plan-2 (silent-pool estimate→headroom): the consumption estimate within the
   * current window, in the pool's native unit (cf. `PoolConfig.capacity`). When a
   * pool declares `capacity` and a `reportConsumption` signal carries an estimate
   * but no direct headroom evidence, the ledger derives headroom via
   * `headroomFromEstimate(estimate, capacity, hasEvidence)`. Absent → no
   * estimate-driven cap (Plan-1).
   */
  estimate?: number;
}

/**
 * Minimal candidate shape — exactly what filter+rank needs. The registry builds
 * the full ordered chain; the window layer only reads name/pool/preferenceRank.
 */
export interface Candidate {
  name: string;
  pool: string;
  preferenceRank: number;
}

/**
 * An immutable view of ledger state at one `now`. Decisions are pure over this
 * snapshot. An unmapped pool name resolves to `unknown` (implicit single-provider
 * pool — defense in depth, never a throw).
 */
export interface LedgerSnapshot {
  headroom(pool: string): Headroom;
  /**
   * Plan-2 (all-exhausted reopen hint): the projected reopen time for an
   * exhausted pool, or `undefined` if the pool is not exhausted / has no
   * projection. Optional so a Plan-1 snapshot (and test doubles) need not
   * implement it; `filterAndRankByWindow` reads it only to compute the
   * `earliestReopenProjection` hint when every candidate's pool is exhausted.
   */
  reopenProjection?(pool: string): number | undefined;
}

/** Window shape for a pool (config-pack data; the scheduler validates shape, not values). */
export interface PoolWindow {
  lengthMs: number;
  reset: 'rolling-from-first-use' | 'fixed-schedule';
}

/**
 * A parsed, validated CapacityPool. Pool membership, window shape, and preference
 * rank are config-pack data read at startup/reload — the scheduler never authors them.
 */
export interface PoolConfig {
  name: string;
  providers: string[];
  window: PoolWindow;
  signalSources: Array<'reported-quota' | 'retry-after' | 'observed-throttle'>;
  preferenceRank: number;
  /**
   * Plan-2 (silent-pool estimate→headroom): the window's historical capacity in
   * the pool's native unit. When declared, the ledger derives headroom from a
   * consumption estimate via `headroomFromEstimate` and caps the snapshot at
   * `tight` once the estimate crosses `TIGHT_FRACTION * capacity`. ABSENT → the
   * feature is inert (Plan-1 behavior, fail-safe). Positive number when present.
   * Also read by `deployment-registry` via the shared `PoolConfigSchema`, so it
   * MUST stay optional (existing fleet fixtures declare neither field).
   */
  capacity?: number;
  /**
   * Plan-2 (repeated-throttle self-correction): the number of consecutive
   * ambiguous/throttle signals on a pool the ledger still calls `ample` that
   * escalates it to `exhausted` (misclassification self-correction). ABSENT →
   * the pool never auto-escalates (Plan-1 behavior). Positive integer when
   * present. Optional for the same shared-schema reason as `capacity`.
   */
  threshold?: number;
}

/**
 * Stamped on one completed session, persisted in the same step as the session
 * result. `reviewVerdictId` is set for review sessions (groups review quality per
 * pool for drift detection). Consumers derive fit metrics from the join keys; this
 * record is never a cost-minimization input.
 */
export type PoolOutcomeProvenance = {
  runId: string;
  role: string;
  poolName: string;
  providerName: string;
  modelBinding: string;
  windowStateAtDispatch: Headroom;
  recordedAt: number;
  reviewVerdictId?: string;
};

/**
 * Result of the pure filter+rank stage. `eligible` is the re-ordered survivor
 * list (exhausted pools removed, tight sunk below ample within rank); `excludePools`
 * names every exhausted pool so the caller can extend the registry's `exclude` set.
 * Empty `eligible` → caller raises provider-unavailable + reopen hint.
 */
export interface FilterRankResult {
  eligible: Candidate[];
  excludePools: string[];
  /**
   * Plan-2 (all-exhausted reopen hint): when `eligible` is EMPTY because every
   * relevant pool is exhausted, the MINIMUM `reopenProjection` across those
   * exhausted pools — so the caller can end the provider-unavailable pause AT the
   * earliest reopen rather than only on probe success. UNDEFINED whenever any
   * candidate is eligible (there is nothing to wait for).
   */
  earliestReopenProjection?: number;
}
