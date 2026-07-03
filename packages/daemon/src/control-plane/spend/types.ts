/**
 * STACK-AC-SPEND-OBSERVABILITY — shared types for the spend projection.
 *
 * A READ-ONLY projection over Data-Platform-owned records
 * (ARCH-AC-SPEND-OBSERVABILITY): nothing here is stored; every figure is
 * recomputed on demand from `CostEventStore`/`RunStore`/`RepoStore` rows and
 * the current PricingReference. Money is carried as decimal-integer strings
 * of MICRO-units (1 money unit = 1,000,000 micros) — `bigint` accumulation
 * happens inside the read model, but `bigint` is never stored or transported
 * (`JSON.stringify` throws on it).
 */

/** Half-open time window `[from, to)` — matches the db reader's `CostEventWindow`. */
export interface Window {
  from: Date;
  to: Date;
}

/** The named periods the API accepts (FUNC-AC-SPEND-OBSERVABILITY scenario 2). */
export type NamedPeriod = 'today' | '7d' | '30d';

/** A parsed, validated period query: a named window or a custom range. */
export type PeriodQuery =
  | { kind: 'named'; period: NamedPeriod }
  | { kind: 'custom'; from: Date; to: Date };

/**
 * One cost event reconciled to the common money unit and joined to its
 * provider / project / time — the derived row every aggregate sums over
 * (L2 "Spend Record"; derived, never stored). `null` on a dimension means
 * UNATTRIBUTED on that dimension — surfaced explicitly, never guessed.
 * `micros === null` means the record could not be reconciled to money
 * (it is counted in the `unreconciled` remainder, never silently dropped).
 */
export interface SpendRecord {
  costEventId: string;
  runId: string;
  sessionType: string;
  provider: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Reconciled money in micro-units (decimal-integer string), or null when unreconcilable. */
  micros: string | null;
  /** Runtime-reported usage units (tokens), or null when unknown. */
  usageUnits: number | null;
  /** The timestamp that places this spend in time: run completion, falling back to recording time. */
  occurredAt: string;
}

/** A provider's share of the period's money and usage. `provider: null` = the explicit unattributed bucket. */
export interface ProviderShare {
  provider: string | null;
  moneyMicros: string;
  usageUnits: number;
}

/** The explicit unreconciled remainder — records missing the data to value them (L2 error contract). */
export interface UnreconciledRemainder {
  count: number;
  usageUnits: number;
}

/** Preceding-equal-length-period deltas for the headline figures (signed decimal-integer micros). */
export interface HeadlineDelta {
  moneyMicros: string;
  usageUnits: number;
}

/** The window echoed on every response, ISO-8601. */
export interface WindowBody {
  from: string;
  to: string;
}

/**
 * The figures scoped to a period (L2 "Period Aggregate" headline): total money
 * and usage, the per-provider split of both, the unreconciled remainder, the
 * preceding-period deltas, and the data-derived Currency Marker (`null` on an
 * empty period — never the current time).
 */
export interface PeriodAggregate {
  window: WindowBody;
  totalMicros: string;
  totalUsageUnits: number;
  providers: ProviderShare[];
  unreconciled: UnreconciledRemainder;
  delta: HeadlineDelta;
  currencyMarker: string | null;
}

/** One ranked project row: share of the period, its provider split, and the records beneath (drill-down-ready). */
export interface ProjectAttribution {
  /** `null` = the single explicit unattributed row (never dropped, never guessed). */
  projectId: string | null;
  projectName: string | null;
  moneyMicros: string;
  usageUnits: number;
  /** This project's share of the period's reconciled total, in basis points (0–10000; 0 when the total is 0). */
  shareBps: number;
  providers: ProviderShare[];
  records: SpendRecord[];
}

/** The spend-by-project response: ranked projects + the headline context. */
export interface ProjectSpendBody {
  window: WindowBody;
  totalMicros: string;
  totalUsageUnits: number;
  delta: HeadlineDelta;
  currencyMarker: string | null;
  projects: ProjectAttribution[];
}

/** The provider-split response. */
export interface ProviderSplitBody {
  window: WindowBody;
  totalMicros: string;
  totalUsageUnits: number;
  delta: HeadlineDelta;
  currencyMarker: string | null;
  providers: ProviderShare[];
}

/** One day bucket of the within-period savings series. */
export interface SavingsSeriesPoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  apportionedFeeMicros: string;
  meteredEstimateMicros: string;
  savingMicros: string;
}

/**
 * The flat-vs-metered comparison for ONE flat provider over the period
 * (L2 "Savings Comparison"). A flat provider with no alternative metered
 * price (configured or per-read override) yields its known figures with
 * `comparisonAvailable: false` — the rest of the view still renders.
 */
export interface SavingsComparison {
  provider: string;
  apportionedFeeMicros: string;
  usageUnits: number;
  comparisonAvailable: boolean;
  meteredEstimateMicros: string | null;
  savingMicros: string | null;
  series: SavingsSeriesPoint[];
}

/** The savings response: one comparison per flat provider (metered providers are simply absent). */
export interface SavingsBody {
  window: WindowBody;
  currencyMarker: string | null;
  comparisons: SavingsComparison[];
}

/**
 * The typed, already-categorized throw for a Data-Platform `StoreResult`
 * unavailable outcome. The read model NEVER re-parses driver text — it
 * branches on the Store's category and throws this; the handler's try/catch
 * maps it to `{ status: 503 }` without crashing the control server.
 */
export class SpendUnavailableError extends Error {
  readonly category: 'unreachable' | 'rejected';

  constructor(category: 'unreachable' | 'rejected', message: string) {
    super(message);
    this.name = 'SpendUnavailableError';
    this.category = category;
  }
}
