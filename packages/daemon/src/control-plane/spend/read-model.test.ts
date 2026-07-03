/**
 * STACK-AC-SPEND-OBSERVABILITY — SpendReadModel unit tests.
 *
 * Hand-rolled reader fakes (no Postgres, no port) pin the L2/L3 contract:
 *   - reconcile: metered = money; flat = usage × alt price; missing alt price
 *     or missing usage → unreconciled (visible remainder, never dropped)
 *   - headline: bigint micro-unit totals, per-provider split of money AND
 *     usage, NULL provider → explicit unattributed bucket, preceding-window
 *     deltas, data-derived Currency Marker, empty period = zeroed 200-state
 *   - byProject: ranked desc, share, provider split, records beneath
 *     (drill-down-ready), NULL project → single unattributed row
 *   - savings: apportioned (never full-charged) fee vs metered estimate,
 *     daily series, per-read override, comparison-unavailable degradation
 *   - fail-safety: StoreResult.unavailable → typed SpendUnavailableError
 *     carrying the Store's category (never re-parsed driver text)
 */
import { describe, it, expect } from 'vitest';
import type {
  CostEvent,
  ProjectName,
  RunAttribution,
  StoreResult,
} from '@auto-claude/db';
import type { PricingReference } from './pricing-reference.js';
import { SpendUnavailableError, type PeriodQuery } from './types.js';
import {
  SpendReadModel,
  reconcile,
  toMicros,
  type SpendReadModelDeps,
} from './read-model.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-03T00:00:00.000Z');
const WINDOW: PeriodQuery = {
  kind: 'custom',
  from: new Date('2026-07-01T00:00:00.000Z'),
  to: new Date('2026-07-03T00:00:00.000Z'),
};

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function unavailable<T>(category: 'unreachable' | 'rejected'): StoreResult<T> {
  return {
    ok: false,
    error: 'unavailable',
    message: `store ${category}`,
    category,
    cause: { class: 'FakeError', code: null, message: `store ${category}` },
  };
}

function event(overrides: Partial<CostEvent> & Pick<CostEvent, 'id' | 'runId'>): CostEvent {
  return {
    sessionType: 'implementation',
    cost: 0,
    provider: null,
    usageUnits: null,
    recordedAt: new Date('2026-07-01T12:00:00.000Z'),
    ...overrides,
  } as CostEvent;
}

const PRICING: PricingReference = {
  claude: {
    kind: 'flat',
    feeMicros: '60000000',
    periodDays: 30,
    altMeteredPriceMicrosPerUnit: '100',
  },
  kimi: { kind: 'flat', feeMicros: '30000000', periodDays: 30 }, // no alt price
  codex: { kind: 'metered' },
};

// e1: flat provider valued at the alt price (1000 × 100 = 100000 micros)
const E1 = event({
  id: 'e1',
  runId: 'r1',
  provider: 'claude',
  cost: 0,
  usageUnits: 1000,
  recordedAt: new Date('2026-07-01T05:00:00.000Z'),
});
// e2: metered provider — cost IS money (2.5 → 2500000 micros)
const E2 = event({
  id: 'e2',
  runId: 'r2',
  provider: 'codex',
  cost: 2.5,
  usageUnits: 500,
  recordedAt: new Date('2026-07-02T00:00:00.000Z'),
});
// e3: NULL provider — unattributed bucket; unknown shape defaults to metered
const E3 = event({
  id: 'e3',
  runId: 'r3',
  provider: null,
  cost: 1.0,
  usageUnits: null,
  recordedAt: new Date('2026-07-02T12:00:00.000Z'),
});
// e4: flat provider WITHOUT an alt price — unreconciled remainder
const E4 = event({
  id: 'e4',
  runId: 'r1',
  provider: 'kimi',
  cost: 0,
  usageUnits: 200,
  recordedAt: new Date('2026-07-01T08:00:00.000Z'),
});

const ATTRIBUTIONS: RunAttribution[] = [
  { runId: 'r1', projectId: 'p1', completedAt: new Date('2026-07-02T06:00:00.000Z') },
  { runId: 'r2', projectId: 'p2', completedAt: new Date('2026-07-02T18:00:00.000Z') },
  { runId: 'r3', projectId: null, completedAt: null },
];

const NAMES: ProjectName[] = [
  { id: 'p1', name: 'daniel/auto-claude' },
  { id: 'p2', name: 'daniel/demo' },
];

// preceding-window event: 1.0 metered + 100 usage
const PRECEDING = [
  event({
    id: 'e0',
    runId: 'r0',
    provider: 'codex',
    cost: 1.0,
    usageUnits: 100,
    recordedAt: new Date('2026-06-30T12:00:00.000Z'),
  }),
];

function makeModel(overrides?: Partial<SpendReadModelDeps>): SpendReadModel {
  const currentFrom = (WINDOW as { from: Date }).from.getTime();
  return new SpendReadModel({
    costEvents: {
      listForWindow: async (w) =>
        ok(w.from.getTime() === currentFrom ? [E1, E2, E3, E4] : PRECEDING),
    },
    runs: { attributionFor: async () => ok(ATTRIBUTIONS) },
    repos: { namesFor: async () => ok(NAMES) },
    loadPricing: async () => PRICING,
    now: () => NOW,
    ...overrides,
  });
}

// ── reconcile ────────────────────────────────────────────────────────────────

describe('reconcile', () => {
  it('converts a metered amount to integer micro-units', () => {
    expect(reconcile({ cost: 1.5, usageUnits: null }, { kind: 'metered' })).toEqual({
      micros: 1_500_000n,
    });
    expect(toMicros(0.000001)).toBe(1n);
  });

  it('values flat usage at the alternative metered price', () => {
    expect(
      reconcile(
        { cost: 0, usageUnits: 1000 },
        { kind: 'flat', feeMicros: '60000000', periodDays: 30, altMeteredPriceMicrosPerUnit: '100' },
      ),
    ).toEqual({ micros: 100_000n });
  });

  it('a per-call override replaces the configured alt price', () => {
    expect(
      reconcile(
        { cost: 0, usageUnits: 1000 },
        { kind: 'flat', feeMicros: '60000000', periodDays: 30, altMeteredPriceMicrosPerUnit: '100' },
        '250',
      ),
    ).toEqual({ micros: 250_000n });
  });

  it('flat without an alt price is unreconciled (never guessed)', () => {
    expect(
      reconcile({ cost: 0, usageUnits: 1000 }, { kind: 'flat', feeMicros: '5', periodDays: 30 }),
    ).toEqual({ unreconciled: true });
  });

  it('flat with NULL usage is unreconciled — "0" alt price is still a valid price', () => {
    expect(
      reconcile(
        { cost: 0, usageUnits: null },
        { kind: 'flat', feeMicros: '5', periodDays: 30, altMeteredPriceMicrosPerUnit: '0' },
      ),
    ).toEqual({ unreconciled: true });
    // strict-boolean trap: "0" must be USED, not treated as missing.
    expect(
      reconcile(
        { cost: 0, usageUnits: 10 },
        { kind: 'flat', feeMicros: '5', periodDays: 30, altMeteredPriceMicrosPerUnit: '0' },
      ),
    ).toEqual({ micros: 0n });
  });
});

// ── headline ─────────────────────────────────────────────────────────────────

describe('SpendReadModel.headline', () => {
  it('reconciles totals in micro-units with the unreconciled remainder visible', async () => {
    const headline = await makeModel().headline(WINDOW);
    // 100000 (claude est) + 2500000 (codex) + 1000000 (unattributed metered)
    expect(headline.totalMicros).toBe('3600000');
    expect(headline.totalUsageUnits).toBe(1700);
    expect(headline.unreconciled).toEqual({ count: 1, usageUnits: 200 });
  });

  it('splits money AND usage per provider with an explicit unattributed bucket', async () => {
    const headline = await makeModel().headline(WINDOW);
    expect(headline.providers).toEqual([
      { provider: 'codex', moneyMicros: '2500000', usageUnits: 500 },
      { provider: null, moneyMicros: '1000000', usageUnits: 0 },
      { provider: 'claude', moneyMicros: '100000', usageUnits: 1000 },
      { provider: 'kimi', moneyMicros: '0', usageUnits: 200 },
    ]);
  });

  it('carries deltas versus the immediately preceding equal-length window', async () => {
    const headline = await makeModel().headline(WINDOW);
    // preceding: 1000000 micros, 100 usage
    expect(headline.delta).toEqual({ moneyMicros: '2600000', usageUnits: 1600 });
  });

  it('derives the Currency Marker from the included records, not the clock', async () => {
    const headline = await makeModel().headline(WINDOW);
    // max(completedAt ?? recordedAt) = r2's completion
    expect(headline.currencyMarker).toBe('2026-07-02T18:00:00.000Z');
  });

  it('an empty period is the zeroed success state with a null marker', async () => {
    const model = makeModel({
      costEvents: { listForWindow: async () => ok([]) },
    });
    const headline = await model.headline(WINDOW);
    expect(headline.totalMicros).toBe('0');
    expect(headline.totalUsageUnits).toBe(0);
    expect(headline.providers).toEqual([]);
    expect(headline.unreconciled).toEqual({ count: 0, usageUnits: 0 });
    expect(headline.delta).toEqual({ moneyMicros: '0', usageUnits: 0 });
    expect(headline.currencyMarker).toBeNull();
  });

  it('a negative delta is a signed decimal string', async () => {
    const model = makeModel({
      costEvents: {
        listForWindow: async (w) =>
          ok(w.from.getTime() === (WINDOW as { from: Date }).from.getTime() ? [] : PRECEDING),
      },
    });
    const headline = await model.headline(WINDOW);
    expect(headline.delta).toEqual({ moneyMicros: '-1000000', usageUnits: -100 });
  });
});

// ── byProject ────────────────────────────────────────────────────────────────

describe('SpendReadModel.byProject', () => {
  it('ranks projects by spend with share, provider split, and records beneath', async () => {
    const body = await makeModel().byProject(WINDOW);
    expect(body.projects.map((p) => p.projectId)).toEqual(['p2', null, 'p1']);

    const p2 = body.projects[0]!;
    expect(p2.projectName).toBe('daniel/demo');
    expect(p2.moneyMicros).toBe('2500000');
    expect(p2.shareBps).toBe(6944); // 2500000 / 3600000
    expect(p2.records.map((r) => r.costEventId)).toEqual(['e2']);

    // Drill-down-ready: p1 carries BOTH its records, including the unreconciled one.
    const p1 = body.projects[2]!;
    expect(p1.projectName).toBe('daniel/auto-claude');
    expect(p1.moneyMicros).toBe('100000');
    expect(p1.usageUnits).toBe(1200);
    expect(p1.records.map((r) => r.costEventId).sort()).toEqual(['e1', 'e4']);
    expect(p1.records.find((r) => r.costEventId === 'e4')?.micros).toBeNull();
    expect(p1.providers.map((s) => s.provider)).toEqual(['claude', 'kimi']);
  });

  it('surfaces spend with no project as a distinct unattributed row, never dropped', async () => {
    const body = await makeModel().byProject(WINDOW);
    const unattributed = body.projects.find((p) => p.projectId === null);
    expect(unattributed).toBeDefined();
    expect(unattributed?.projectName).toBeNull();
    expect(unattributed?.moneyMicros).toBe('1000000');
    expect(unattributed?.records.map((r) => r.costEventId)).toEqual(['e3']);
  });

  it('a run absent from the attribution result is unattributed, never invented', async () => {
    const model = makeModel({
      runs: { attributionFor: async () => ok([]) },
    });
    const body = await model.byProject(WINDOW);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.projectId).toBeNull();
    expect(body.projects[0]?.records).toHaveLength(4);
  });

  it('shareBps is 0 when the reconciled total is 0 (no division blow-up)', async () => {
    const model = makeModel({
      costEvents: { listForWindow: async () => ok([E4]) }, // only the unreconciled row
    });
    const body = await model.byProject(WINDOW);
    expect(body.totalMicros).toBe('0');
    expect(body.projects[0]?.shareBps).toBe(0);
  });
});

// ── providerSplit ────────────────────────────────────────────────────────────

describe('SpendReadModel.providerSplit', () => {
  it('returns the per-provider shares with the headline envelope', async () => {
    const body = await makeModel().providerSplit(WINDOW);
    expect(body.providers.map((s) => s.provider)).toEqual(['codex', null, 'claude', 'kimi']);
    expect(body.totalMicros).toBe('3600000');
    expect(body.currencyMarker).toBe('2026-07-02T18:00:00.000Z');
    expect(body.delta.moneyMicros).toBe('2600000');
  });
});

// ── savings ──────────────────────────────────────────────────────────────────

describe('SpendReadModel.savings', () => {
  it('apportions the flat fee (never full-charges) and values usage at the alt price', async () => {
    const body = await makeModel().savings(WINDOW);
    const claude = body.comparisons.find((c) => c.provider === 'claude');
    // 2-day window over a 30-day subscription: 60000000 × 2/30 = 4000000
    expect(claude?.apportionedFeeMicros).toBe('4000000');
    expect(claude?.meteredEstimateMicros).toBe('100000'); // 1000 × 100
    expect(claude?.savingMicros).toBe('3900000');
    expect(claude?.comparisonAvailable).toBe(true);
  });

  it('buckets the comparison by UTC day within the window', async () => {
    const body = await makeModel().savings(WINDOW);
    const claude = body.comparisons.find((c) => c.provider === 'claude');
    // usage occurred at r1's completion (2026-07-02); each day gets half the fee.
    expect(claude?.series).toEqual([
      {
        day: '2026-07-01',
        apportionedFeeMicros: '2000000',
        meteredEstimateMicros: '0',
        savingMicros: '2000000',
      },
      {
        day: '2026-07-02',
        apportionedFeeMicros: '2000000',
        meteredEstimateMicros: '100000',
        savingMicros: '1900000',
      },
    ]);
  });

  it('a flat provider with no alt price yields known figures, comparison unavailable', async () => {
    const body = await makeModel().savings(WINDOW);
    const kimi = body.comparisons.find((c) => c.provider === 'kimi');
    expect(kimi).toEqual({
      provider: 'kimi',
      apportionedFeeMicros: '2000000', // 30000000 × 2/30
      usageUnits: 200,
      comparisonAvailable: false,
      meteredEstimateMicros: null,
      savingMicros: null,
      series: [],
    });
  });

  it('metered providers are absent from the comparison (nothing to compare)', async () => {
    const body = await makeModel().savings(WINDOW);
    expect(body.comparisons.map((c) => c.provider).sort()).toEqual(['claude', 'kimi']);
  });

  it('a per-read override re-values THIS read only (and unlocks a no-alt provider)', async () => {
    const model = makeModel();
    const overridden = await model.savings(WINDOW, { claude: '200', kimi: '50' });
    const claude = overridden.comparisons.find((c) => c.provider === 'claude');
    expect(claude?.meteredEstimateMicros).toBe('200000'); // 1000 × 200
    expect(claude?.savingMicros).toBe('3800000');
    const kimi = overridden.comparisons.find((c) => c.provider === 'kimi');
    expect(kimi?.comparisonAvailable).toBe(true);
    expect(kimi?.meteredEstimateMicros).toBe('10000'); // 200 × 50

    // transient: the next read without an override uses the configured prices again
    const plain = await model.savings(WINDOW);
    expect(plain.comparisons.find((c) => c.provider === 'claude')?.meteredEstimateMicros).toBe(
      '100000',
    );
    expect(plain.comparisons.find((c) => c.provider === 'kimi')?.comparisonAvailable).toBe(false);
  });
});

// ── fail-safety ──────────────────────────────────────────────────────────────

describe('SpendReadModel fail-safety', () => {
  it('cost-event reader unavailable(unreachable) → SpendUnavailableError with the category', async () => {
    const model = makeModel({
      costEvents: { listForWindow: async () => unavailable('unreachable') },
    });
    const error = await model.headline(WINDOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendUnavailableError);
    expect((error as SpendUnavailableError).category).toBe('unreachable');
  });

  it('run reader unavailable(rejected) → SpendUnavailableError(rejected)', async () => {
    const model = makeModel({
      runs: { attributionFor: async () => unavailable('rejected') },
    });
    const error = await model.byProject(WINDOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendUnavailableError);
    expect((error as SpendUnavailableError).category).toBe('rejected');
  });

  it('repo reader denied is treated as the store rejecting the read', async () => {
    const model = makeModel({
      repos: {
        namesFor: async () => ({ ok: false, error: 'denied', message: 'no' }),
      },
    });
    const error = await model.byProject(WINDOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendUnavailableError);
    expect((error as SpendUnavailableError).category).toBe('rejected');
  });
});

// ── empty-string pricing key must never alias unattributed spend ─────────────

describe('empty-string pricing key (unattributed aliasing guard)', () => {
  // A hand-edited state file (or any schema bypass) with an "" key must not
  // revalue NULL-provider rows or fabricate an empty-provider comparison.
  const HOSTILE_PRICING: PricingReference = {
    '': { kind: 'flat', feeMicros: '30000000', periodDays: 30 },
  };

  it('a NULL-provider row keeps default metered handling, never the "" shape', async () => {
    const model = makeModel({
      costEvents: { listForWindow: async () => ok([E3]) }, // NULL provider, cost 1.0
      loadPricing: async () => HOSTILE_PRICING,
    });
    const headline = await model.headline(WINDOW);
    // metered default: cost IS money — NOT flat-unreconciled under the "" shape
    expect(headline.totalMicros).toBe('1000000');
    expect(headline.unreconciled).toEqual({ count: 0, usageUnits: 0 });
    expect(headline.providers).toEqual([
      { provider: null, moneyMicros: '1000000', usageUnits: 0 },
    ]);
  });

  it('savings never fabricates a comparison for an empty provider id', async () => {
    const model = makeModel({
      costEvents: { listForWindow: async () => ok([E3]) },
      loadPricing: async () => HOSTILE_PRICING,
    });
    const body = await model.savings(WINDOW);
    expect(body.comparisons).toEqual([]);
  });
});
