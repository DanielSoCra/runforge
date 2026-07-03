/**
 * STACK-AC-SPEND-OBSERVABILITY — the pure SpendReadModel.
 *
 * A read-only projection over the Data-Platform narrow readers (the query
 * subset landed for this projection — NOT the pooled db or the Store classes):
 * per request it fetches the period window AND the immediately-preceding
 * equal-length window, reconciles every cost amount to integer micro-units,
 * joins each cost event to its provider / project / completion time to form
 * `SpendRecord[]`, and folds those into the period aggregates. All arithmetic
 * is a pure function of the fetched rows + the current PricingReference —
 * unit-tested with hand-rolled reader fakes, no Postgres, no port.
 *
 * Load-bearing numerical rule: money is accumulated in `bigint` micro-units
 * (float money silently breaks "totals reconcile with the underlying records",
 * an L1 success criterion) and leaves this module only as decimal-integer
 * strings (`bigint` is not JSON-serializable).
 *
 * Fail-safety is structural: a `StoreResult.unavailable` value → a typed
 * `SpendUnavailableError` carrying the Store's already-categorized reason
 * (`unreachable` | `rejected`) — the ONLY throw this layer raises; the handler
 * maps it to 503. An EMPTY period is the success state (zeroed totals, empty
 * splits). Records that cannot be reconciled surface as an explicit
 * `unreconciled` remainder; NULL provider/project rows fold into an explicit
 * `unattributed` bucket — nothing is silently dropped, guessed, or invented.
 */
import type {
  CostEvent,
  CostEventWindow,
  ProjectName,
  RunAttribution,
  StoreResult,
} from '@auto-claude/db';
import type { BillingShape, PricingReference } from './pricing-reference.js';
import { DEFAULT_BILLING_SHAPE } from './pricing-reference.js';
import { periodWindow, precedingWindow } from './windows.js';
import {
  SpendUnavailableError,
  type HeadlineDelta,
  type PeriodAggregate,
  type PeriodQuery,
  type ProjectAttribution,
  type ProjectSpendBody,
  type ProviderShare,
  type ProviderSplitBody,
  type SavingsBody,
  type SavingsComparison,
  type SavingsSeriesPoint,
  type SpendRecord,
  type UnreconciledRemainder,
  type Window,
  type WindowBody,
} from './types.js';

const DAY_MS = 86_400_000n;
const MICROS_PER_UNIT = 1_000_000;

// ── narrow readers (L3 Key Decision: inject readers, not db/Store classes) ──

/** The cost-event query surface this projection needs (satisfied by `CostEventStore`). */
export interface CostEventReader {
  listForWindow(window: CostEventWindow): Promise<StoreResult<CostEvent[]>>;
}

/** The run join surface (satisfied by `RunStore`). */
export interface RunReader {
  attributionFor(runIds: string[]): Promise<StoreResult<RunAttribution[]>>;
}

/** The project display-name surface (satisfied by `RepoStore`). */
export interface RepoReader {
  namesFor(projectIds: string[]): Promise<StoreResult<ProjectName[]>>;
}

export interface SpendReadModelDeps {
  costEvents: CostEventReader;
  runs: RunReader;
  repos: RepoReader;
  /** The current Operator-owned pricing configuration (read per request — a set re-values the next read). */
  loadPricing: () => Promise<PricingReference>;
  /** Injected clock, used ONLY to resolve named periods (no `Date.now()` on the read path). */
  now: () => Date;
}

/** Per-read alternative-price overrides for the savings comparison (never persisted). */
export type AltPriceOverrides = Record<string, string>;

// ── reconciliation ───────────────────────────────────────────────────────────

/** Convert a money amount (deployment money units, numeric scale ≤ 6) to integer micro-units. */
export function toMicros(amount: number): bigint {
  return BigInt(Math.round(amount * MICROS_PER_UNIT));
}

/**
 * Reconcile ONE cost event to integer micro-units under the provider's billing
 * shape: a metered provider's event is already money; a flat provider's usage
 * is valued at its alternative metered price reference. A flat event with no
 * alternative price — or no reported usage to value — is UNRECONCILED (made
 * visible as a remainder, never silently dropped or float-guessed).
 */
export function reconcile(
  event: Pick<CostEvent, 'cost' | 'usageUnits'>,
  shape: BillingShape,
  altPriceOverride?: string,
): { micros: bigint } | { unreconciled: true } {
  if (shape.kind === 'metered') return { micros: toMicros(event.cost) };
  const altPrice = altPriceOverride ?? shape.altMeteredPriceMicrosPerUnit;
  if (altPrice === undefined) return { unreconciled: true };
  if (event.usageUnits === null) return { unreconciled: true };
  return { micros: BigInt(event.usageUnits) * BigInt(altPrice) };
}

// ── internal row shape ───────────────────────────────────────────────────────

/** A `SpendRecord` plus its `bigint` money (kept internal — never serialized). */
interface ReconciledRow {
  record: SpendRecord;
  micros: bigint | null;
  usageUnits: number | null;
  provider: string | null;
  projectId: string | null;
  occurredAt: Date;
}

interface FoldedTotals {
  totalMicros: bigint;
  totalUsageUnits: number;
  unreconciled: UnreconciledRemainder;
}

// ── the read model ───────────────────────────────────────────────────────────

export class SpendReadModel {
  readonly #deps: SpendReadModelDeps;

  constructor(deps: SpendReadModelDeps) {
    this.#deps = deps;
  }

  /** GET /spend/period — the unified headline: totals, provider split, deltas, Currency Marker. */
  async headline(query: PeriodQuery): Promise<PeriodAggregate> {
    const window = periodWindow(query, this.#deps.now());
    const pricing = await this.#deps.loadPricing();
    const rows = await this.#fetchRows(window, pricing);
    const totals = foldTotals(rows);
    return {
      window: toWindowBody(window),
      totalMicros: totals.totalMicros.toString(),
      totalUsageUnits: totals.totalUsageUnits,
      providers: foldProviders(rows),
      unreconciled: totals.unreconciled,
      delta: await this.#delta(window, totals, pricing),
      currencyMarker: currencyMarker(rows),
    };
  }

  /** GET /spend/by-project — projects ranked by spend, each drill-down-ready, plus the unattributed row. */
  async byProject(query: PeriodQuery): Promise<ProjectSpendBody> {
    const window = periodWindow(query, this.#deps.now());
    const pricing = await this.#deps.loadPricing();
    const rows = await this.#fetchRows(window, pricing);
    const totals = foldTotals(rows);
    return {
      window: toWindowBody(window),
      totalMicros: totals.totalMicros.toString(),
      totalUsageUnits: totals.totalUsageUnits,
      delta: await this.#delta(window, totals, pricing),
      currencyMarker: currencyMarker(rows),
      projects: foldProjects(rows, totals.totalMicros),
    };
  }

  /** GET /spend/provider-split — each provider's share of money AND usage, distinctly. */
  async providerSplit(query: PeriodQuery): Promise<ProviderSplitBody> {
    const window = periodWindow(query, this.#deps.now());
    const pricing = await this.#deps.loadPricing();
    const rows = await this.#fetchRows(window, pricing);
    const totals = foldTotals(rows);
    return {
      window: toWindowBody(window),
      totalMicros: totals.totalMicros.toString(),
      totalUsageUnits: totals.totalUsageUnits,
      delta: await this.#delta(window, totals, pricing),
      currencyMarker: currencyMarker(rows),
      providers: foldProviders(rows),
    };
  }

  /**
   * GET /spend/savings — for each FLAT provider: the apportioned fee beside the
   * metered estimate, as a total and a within-period daily series. An optional
   * per-read alt-price override re-values THIS read only (never persisted).
   */
  async savings(query: PeriodQuery, overrides?: AltPriceOverrides): Promise<SavingsBody> {
    const window = periodWindow(query, this.#deps.now());
    const pricing = await this.#deps.loadPricing();
    const rows = await this.#fetchRows(window, pricing);
    const comparisons: SavingsComparison[] = [];
    for (const [provider, shape] of Object.entries(pricing)) {
      if (provider === '') continue; // an empty id can never name a real provider — no fabricated comparison
      if (shape.kind !== 'flat') continue; // a metered provider has nothing to compare
      comparisons.push(
        buildComparison(provider, shape, window, rows, overrides?.[provider]),
      );
    }
    return {
      window: toWindowBody(window),
      currencyMarker: currencyMarker(rows),
      comparisons,
    };
  }

  /** Preceding-equal-length-period deltas — only totals are needed, so no attribution joins. */
  async #delta(
    window: Window,
    current: FoldedTotals,
    pricing: PricingReference,
  ): Promise<HeadlineDelta> {
    const preceding = precedingWindow(window);
    const events = unwrap(await this.#deps.costEvents.listForWindow(preceding));
    let moneyMicros = 0n;
    let usageUnits = 0;
    for (const event of events) {
      const shape = pricing[event.provider ?? ''] ?? DEFAULT_BILLING_SHAPE;
      const outcome = reconcile(event, shape);
      if ('micros' in outcome) moneyMicros += outcome.micros;
      if (event.usageUnits !== null) usageUnits += event.usageUnits;
    }
    return {
      moneyMicros: (current.totalMicros - moneyMicros).toString(),
      usageUnits: current.totalUsageUnits - usageUnits,
    };
  }

  /** Fetch the window's events and join provider / project / completion time into reconciled rows. */
  async #fetchRows(window: Window, pricing: PricingReference): Promise<ReconciledRow[]> {
    const events = unwrap(await this.#deps.costEvents.listForWindow(window));
    if (events.length === 0) return [];

    const runIds = [...new Set(events.map((event) => event.runId))];
    const attributions = unwrap(await this.#deps.runs.attributionFor(runIds));
    const attributionByRun = new Map(attributions.map((a) => [a.runId, a]));

    const projectIds = [
      ...new Set(
        attributions
          .map((a) => a.projectId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const names =
      projectIds.length === 0
        ? []
        : unwrap(await this.#deps.repos.namesFor(projectIds));
    const nameById = new Map(names.map((n) => [n.id, n.name]));

    return events.map((event) => {
      const attribution = attributionByRun.get(event.runId);
      const provider = event.provider;
      const projectId = attribution?.projectId ?? null;
      // NULL provider = unattributed; it never matches a pricing entry (an
      // empty-string key must not revalue unattributed spend).
      const shape =
        provider === null
          ? DEFAULT_BILLING_SHAPE
          : (pricing[provider] ?? DEFAULT_BILLING_SHAPE);
      const outcome = reconcile(event, shape);
      const micros = 'micros' in outcome ? outcome.micros : null;
      // Completion time places spend in time (L2); recording time is the
      // data-derived fallback for runs that never completed.
      const occurredAt = attribution?.completedAt ?? event.recordedAt;
      return {
        record: {
          costEventId: event.id,
          runId: event.runId,
          sessionType: event.sessionType,
          provider,
          projectId,
          projectName: projectId === null ? null : (nameById.get(projectId) ?? null),
          micros: micros === null ? null : micros.toString(),
          usageUnits: event.usageUnits,
          occurredAt: occurredAt.toISOString(),
        },
        micros,
        usageUnits: event.usageUnits,
        provider,
        projectId,
        occurredAt,
      };
    });
  }
}

// ── pure folds ───────────────────────────────────────────────────────────────

/**
 * Unwrap a Data-Platform `StoreResult`: `unavailable` becomes the typed,
 * already-categorized `SpendUnavailableError` (the handler's 503); the other
 * non-ok outcomes (`denied`/`not-found` — not expected from these list
 * readers) are treated as the Store rejecting the read. NEVER re-parses
 * driver text — the Store's seam already categorized the failure.
 */
function unwrap<T>(result: StoreResult<T>): T {
  if (result.ok) return result.value;
  if (result.error === 'unavailable') {
    throw new SpendUnavailableError(result.category, result.message);
  }
  throw new SpendUnavailableError('rejected', result.message);
}

function toWindowBody(window: Window): WindowBody {
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}

function foldTotals(rows: ReconciledRow[]): FoldedTotals {
  let totalMicros = 0n;
  let totalUsageUnits = 0;
  const unreconciled: UnreconciledRemainder = { count: 0, usageUnits: 0 };
  for (const row of rows) {
    if (row.micros !== null) {
      totalMicros += row.micros;
    } else {
      unreconciled.count += 1;
      if (row.usageUnits !== null) unreconciled.usageUnits += row.usageUnits;
    }
    if (row.usageUnits !== null) totalUsageUnits += row.usageUnits;
  }
  return { totalMicros, totalUsageUnits, unreconciled };
}

/** Per-provider split of money AND usage; `provider: null` is the explicit unattributed bucket. */
function foldProviders(rows: ReconciledRow[]): ProviderShare[] {
  const byProvider = new Map<string | null, { money: bigint; usage: number }>();
  for (const row of rows) {
    const entry = byProvider.get(row.provider) ?? { money: 0n, usage: 0 };
    if (row.micros !== null) entry.money += row.micros;
    if (row.usageUnits !== null) entry.usage += row.usageUnits;
    byProvider.set(row.provider, entry);
  }
  return [...byProvider.entries()]
    .map(([provider, entry]) => ({
      provider,
      moneyMicros: entry.money.toString(),
      usageUnits: entry.usage,
    }))
    .sort(compareByMoneyDesc);
}

/** Projects ranked by spend, each carrying its share, provider split, and records (drill-down-ready). */
function foldProjects(rows: ReconciledRow[], totalMicros: bigint): ProjectAttribution[] {
  const byProject = new Map<string | null, ReconciledRow[]>();
  for (const row of rows) {
    const bucket = byProject.get(row.projectId);
    if (bucket === undefined) {
      byProject.set(row.projectId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return [...byProject.entries()]
    .map(([projectId, projectRows]) => {
      let money = 0n;
      let usage = 0;
      for (const row of projectRows) {
        if (row.micros !== null) money += row.micros;
        if (row.usageUnits !== null) usage += row.usageUnits;
      }
      return {
        projectId,
        projectName:
          projectId === null ? null : (projectRows[0]?.record.projectName ?? null),
        moneyMicros: money.toString(),
        usageUnits: usage,
        shareBps: totalMicros === 0n ? 0 : Number((money * 10_000n) / totalMicros),
        providers: foldProviders(projectRows),
        records: projectRows.map((row) => row.record),
      };
    })
    .sort(compareByMoneyDesc);
}

function compareByMoneyDesc(a: { moneyMicros: string }, b: { moneyMicros: string }): number {
  const diff = BigInt(b.moneyMicros) - BigInt(a.moneyMicros);
  if (diff > 0n) return 1;
  if (diff < 0n) return -1;
  return 0;
}

/**
 * The Currency Marker: the max completion timestamp among the INCLUDED records
 * (data-derived, never a wall-clock read). An empty period has NO marker —
 * `null`, never the current time (which would falsely imply fresh data).
 */
function currencyMarker(rows: ReconciledRow[]): string | null {
  let max: Date | null = null;
  for (const row of rows) {
    if (max === null || row.occurredAt.getTime() > max.getTime()) {
      max = row.occurredAt;
    }
  }
  return max === null ? null : max.toISOString();
}

// ── savings comparison ───────────────────────────────────────────────────────

/**
 * Apportion a flat fee to a span: `fee × spanMs / (periodDays × dayMs)`, all
 * `bigint` (generalizes the L3's whole-day example to custom ranges). A window
 * shorter than the subscription period pro-rates — never full-charges.
 */
function apportionFee(feeMicros: bigint, spanMs: bigint, periodDays: number): bigint {
  return (feeMicros * spanMs) / (BigInt(periodDays) * DAY_MS);
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildComparison(
  provider: string,
  shape: Extract<BillingShape, { kind: 'flat' }>,
  window: Window,
  rows: ReconciledRow[],
  altPriceOverride: string | undefined,
): SavingsComparison {
  const feeMicros = BigInt(shape.feeMicros);
  const windowMs = BigInt(window.to.getTime() - window.from.getTime());
  const apportionedFeeMicros = apportionFee(feeMicros, windowMs, shape.periodDays);
  const providerRows = rows.filter((row) => row.provider === provider);
  let usageUnits = 0;
  for (const row of providerRows) {
    if (row.usageUnits !== null) usageUnits += row.usageUnits;
  }

  // Per-read override (transient, this read only) beats the configured price.
  const altPrice = altPriceOverride ?? shape.altMeteredPriceMicrosPerUnit;
  if (altPrice === undefined) {
    // No reference to value usage at: known figures only, comparison unavailable.
    return {
      provider,
      apportionedFeeMicros: apportionedFeeMicros.toString(),
      usageUnits,
      comparisonAvailable: false,
      meteredEstimateMicros: null,
      savingMicros: null,
      series: [],
    };
  }

  const price = BigInt(altPrice);
  const meteredEstimateMicros = BigInt(usageUnits) * price;

  // Daily series: usage bucketed by the UTC calendar day it occurred, the fee
  // apportioned by each day's overlap with the window (partial edge days get a
  // partial fee), so the series reconciles with the period totals.
  const usageByDay = new Map<string, number>();
  for (const row of providerRows) {
    if (row.usageUnits === null) continue;
    // Clamp into the window: a run can COMPLETE after the window even though
    // its cost was RECORDED inside it — its usage must still land in a series
    // bucket, or the series would not reconcile with the period totals.
    const clamped = Math.min(
      Math.max(row.occurredAt.getTime(), window.from.getTime()),
      window.to.getTime() - 1,
    );
    const key = utcDayKey(new Date(clamped));
    usageByDay.set(key, (usageByDay.get(key) ?? 0) + row.usageUnits);
  }
  const series: SavingsSeriesPoint[] = [];
  const dayMs = Number(DAY_MS);
  for (
    let dayStart = Date.UTC(
      window.from.getUTCFullYear(),
      window.from.getUTCMonth(),
      window.from.getUTCDate(),
    );
    dayStart < window.to.getTime();
    dayStart += dayMs
  ) {
    const overlapFrom = Math.max(dayStart, window.from.getTime());
    const overlapTo = Math.min(dayStart + dayMs, window.to.getTime());
    const dayFee = apportionFee(feeMicros, BigInt(overlapTo - overlapFrom), shape.periodDays);
    const dayKey = utcDayKey(new Date(dayStart));
    const dayEstimate = BigInt(usageByDay.get(dayKey) ?? 0) * price;
    series.push({
      day: dayKey,
      apportionedFeeMicros: dayFee.toString(),
      meteredEstimateMicros: dayEstimate.toString(),
      savingMicros: (dayFee - dayEstimate).toString(),
    });
  }

  return {
    provider,
    apportionedFeeMicros: apportionedFeeMicros.toString(),
    usageUnits,
    comparisonAvailable: true,
    meteredEstimateMicros: meteredEstimateMicros.toString(),
    savingMicros: (apportionedFeeMicros - meteredEstimateMicros).toString(),
    series,
  };
}
