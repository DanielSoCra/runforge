/**
 * STACK-AC-SPEND-OBSERVABILITY — Spend API handler tests.
 *
 * Mirrors decision-api.test.ts: hand-rolled fakes, no HTTP server. Pins the
 * `{ status, body }` contract: 200 happy paths, 400 on malformed query/body
 * BEFORE any Store touch, typed SpendUnavailableError → 503 (never rethrown,
 * never presented as zero spend), and the PricingReference PUT validating
 * before persisting.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SpendReadModel } from './read-model.js';
import { PricingReferenceStore } from './pricing-reference.js';
import {
  listPeriodSpend,
  spendByProject,
  providerSplit,
  savingsComparison,
  readPricingReference,
  setPricingReference,
  parsePeriodQuery,
  parseAltOverrides,
} from './spend-api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-07-03T00:00:00.000Z');

/** An empty-but-healthy read model: every window reads as the zeroed success state. */
function emptyModel(): SpendReadModel {
  return new SpendReadModel({
    costEvents: { listForWindow: async () => ({ ok: true, value: [] }) },
    runs: { attributionFor: async () => ({ ok: true, value: [] }) },
    repos: { namesFor: async () => ({ ok: true, value: [] }) },
    loadPricing: async () => ({
      claude: { kind: 'flat', feeMicros: '60000000', periodDays: 30 },
    }),
    now: () => NOW,
  });
}

/** A read model whose store is down (already-categorized unavailable). */
function unavailableModel(): SpendReadModel {
  return new SpendReadModel({
    costEvents: {
      listForWindow: async () => ({
        ok: false,
        error: 'unavailable',
        message: 'connection refused',
        category: 'unreachable',
        cause: { class: 'Error', code: 'ECONNREFUSED', message: 'connection refused' },
      }),
    },
    runs: { attributionFor: async () => ({ ok: true, value: [] }) },
    repos: { namesFor: async () => ({ ok: true, value: [] }) },
    loadPricing: async () => ({}),
    now: () => NOW,
  });
}

async function tempPricingStore(): Promise<PricingReferenceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'spend-api-'));
  return new PricingReferenceStore(join(dir, 'pricing-reference.json'));
}

// ── query parsing ────────────────────────────────────────────────────────────

describe('parsePeriodQuery', () => {
  it('parses named periods', () => {
    expect(parsePeriodQuery(new URLSearchParams('period=today'))).toEqual({
      kind: 'named',
      period: 'today',
    });
    expect(parsePeriodQuery(new URLSearchParams('period=7d'))).toEqual({
      kind: 'named',
      period: '7d',
    });
  });

  it('parses a custom range', () => {
    const query = parsePeriodQuery(
      new URLSearchParams('from=2026-06-01T00:00:00Z&to=2026-06-15T00:00:00Z'),
    );
    expect(query).toEqual({
      kind: 'custom',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-15T00:00:00Z'),
    });
  });

  it('defaults to the last thirty days when no period is given', () => {
    expect(parsePeriodQuery(new URLSearchParams())).toEqual({ kind: 'named', period: '30d' });
  });

  it.each([
    ['unknown named period', 'period=1y'],
    ['from without to', 'from=2026-06-01T00:00:00Z'],
    ['unparseable date', 'from=yesterday&to=2026-06-15T00:00:00Z'],
    ['inverted range', 'from=2026-06-15T00:00:00Z&to=2026-06-01T00:00:00Z'],
    ['named period mixed with a range', 'period=7d&from=2026-06-01T00:00:00Z&to=2026-06-15T00:00:00Z'],
  ])('rejects %s', (_label, qs) => {
    expect(parsePeriodQuery(new URLSearchParams(qs))).toBeNull();
  });
});

describe('parseAltOverrides', () => {
  it('parses repeatable provider:micros overrides', () => {
    expect(parseAltOverrides(new URLSearchParams('alt=claude:100&alt=kimi:0'))).toEqual({
      claude: '100',
      kimi: '0',
    });
  });

  it('returns empty overrides when absent', () => {
    expect(parseAltOverrides(new URLSearchParams())).toEqual({});
  });

  it.each([
    ['missing separator', 'alt=claude100'],
    ['empty provider', 'alt=:100'],
    ['decimal micros', 'alt=claude:1.5'],
    ['negative micros', 'alt=claude:-5'],
  ])('rejects %s', (_label, qs) => {
    expect(parseAltOverrides(new URLSearchParams(qs))).toBeNull();
  });
});

// ── read handlers ────────────────────────────────────────────────────────────

describe('read handlers', () => {
  it('listPeriodSpend: 200 zeroed for an empty period (the success state)', async () => {
    const result = await listPeriodSpend(emptyModel(), new URLSearchParams('period=7d'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      totalMicros: '0',
      totalUsageUnits: 0,
      providers: [],
      currencyMarker: null,
    });
  });

  it('listPeriodSpend: 400 on a malformed period, before any store read', async () => {
    const listForWindow = vi.fn();
    const model = new SpendReadModel({
      costEvents: { listForWindow },
      runs: { attributionFor: vi.fn() },
      repos: { namesFor: vi.fn() },
      loadPricing: async () => ({}),
      now: () => NOW,
    });
    const result = await listPeriodSpend(model, new URLSearchParams('period=nope'));
    expect(result.status).toBe(400);
    expect(listForWindow).not.toHaveBeenCalled();
  });

  it('listPeriodSpend: SpendUnavailableError → 503 with the category logged, never a zero total', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await listPeriodSpend(unavailableModel(), new URLSearchParams('period=7d'));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'spend records unavailable' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
  });

  it('listPeriodSpend: an unexpected throw also maps to 503 (never rethrown)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = emptyModel();
    vi.spyOn(model, 'headline').mockRejectedValue(new Error('boom'));
    const result = await listPeriodSpend(model, new URLSearchParams('period=7d'));
    expect(result.status).toBe(503);
  });

  it('spendByProject: 200 / 400 / 503 mirror the headline contract', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await spendByProject(emptyModel(), new URLSearchParams('period=today'))).status).toBe(200);
    expect((await spendByProject(emptyModel(), new URLSearchParams('period=x'))).status).toBe(400);
    expect((await spendByProject(unavailableModel(), new URLSearchParams('period=7d'))).status).toBe(503);
  });

  it('providerSplit: 200 / 400 / 503 mirror the headline contract', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await providerSplit(emptyModel(), new URLSearchParams('period=today'))).status).toBe(200);
    expect((await providerSplit(emptyModel(), new URLSearchParams('from=x&to=y'))).status).toBe(400);
    expect((await providerSplit(unavailableModel(), new URLSearchParams('period=7d'))).status).toBe(503);
  });

  it('savingsComparison: 200 with flat providers; overrides parsed, never persisted', async () => {
    const result = await savingsComparison(
      emptyModel(),
      new URLSearchParams('period=7d&alt=claude:100'),
    );
    expect(result.status).toBe(200);
    const body = result.body as { comparisons: { provider: string; comparisonAvailable: boolean }[] };
    expect(body.comparisons).toHaveLength(1);
    expect(body.comparisons[0]).toMatchObject({ provider: 'claude', comparisonAvailable: true });
  });

  it('savingsComparison: 400 on a malformed alt override', async () => {
    const result = await savingsComparison(
      emptyModel(),
      new URLSearchParams('period=7d&alt=claude:1.5'),
    );
    expect(result.status).toBe(400);
  });

  it('savingsComparison: unavailable store → 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await savingsComparison(unavailableModel(), new URLSearchParams('period=7d'));
    expect(result.status).toBe(503);
  });
});

// ── PricingReference handlers ────────────────────────────────────────────────

describe('pricing-reference handlers', () => {
  it('read → 200 with the stored configuration (empty by default)', async () => {
    const store = await tempPricingStore();
    expect(await readPricingReference(store)).toEqual({ status: 200, body: {} });
  });

  it('set validates BEFORE persisting: malformed body → 400 and nothing written', async () => {
    const store = await tempPricingStore();
    const result = await setPricingReference(store, {
      claude: { kind: 'flat', feeMicros: 1.5, periodDays: 30 },
    });
    expect(result.status).toBe(400);
    expect(await store.read()).toEqual({}); // untouched
  });

  it('set → 200 and the next read serves the new configuration (round-trip)', async () => {
    const store = await tempPricingStore();
    const reference = {
      claude: { kind: 'flat', feeMicros: '200000000', periodDays: 30, altMeteredPriceMicrosPerUnit: '15' },
      codex: { kind: 'metered' },
    };
    const result = await setPricingReference(store, reference);
    expect(result).toEqual({ status: 200, body: reference });
    expect(await readPricingReference(store)).toEqual({ status: 200, body: reference });
  });

  it('set: a non-object body → 400', async () => {
    const store = await tempPricingStore();
    expect((await setPricingReference(store, null)).status).toBe(400);
    expect((await setPricingReference(store, 'metered')).status).toBe(400);
    expect((await setPricingReference(store, [])).status).toBe(400);
  });

  it('set: a write failure → 503 (never rethrown)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await tempPricingStore();
    vi.spyOn(store, 'write').mockRejectedValue(new Error('disk full'));
    const result = await setPricingReference(store, { codex: { kind: 'metered' } });
    expect(result.status).toBe(503);
  });
});
