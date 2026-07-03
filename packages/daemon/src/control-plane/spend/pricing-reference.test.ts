/**
 * STACK-AC-SPEND-OBSERVABILITY — PricingReference config store tests.
 *
 * Pins: round-trip through the atomic JSON store, fail-open-to-empty on a
 * missing or malformed file (read path), and the Zod schema as the single
 * source of billing-shape truth (money as non-negative decimal-integer
 * strings; "0" is valid — the strict-boolean trap).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BillingShapeSchema,
  PricingReferenceSchema,
  PricingReferenceStore,
  type PricingReference,
} from './pricing-reference.js';

async function tempStore(): Promise<{ store: PricingReferenceStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'spend-pricing-'));
  const path = join(dir, 'pricing-reference.json');
  return { store: new PricingReferenceStore(path), path };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PricingReferenceStore', () => {
  it('round-trips a valid configuration', async () => {
    const { store } = await tempStore();
    const reference: PricingReference = {
      'claude-cli': {
        kind: 'flat',
        feeMicros: '200000000',
        periodDays: 30,
        altMeteredPriceMicrosPerUnit: '15',
      },
      codex: { kind: 'metered' },
    };
    await store.write(reference);
    await expect(store.read()).resolves.toEqual(reference);
  });

  it('reads the empty configuration when the file is missing', async () => {
    const { store } = await tempStore();
    await expect(store.read()).resolves.toEqual({});
  });

  it('reads the empty configuration (and warns) when the file is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, path } = await tempStore();
    await writeFile(path, JSON.stringify({ claude: { kind: 'flat' } })); // missing feeMicros/periodDays
    await expect(store.read()).resolves.toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reads the empty configuration when the file is not JSON', async () => {
    const { store, path } = await tempStore();
    await writeFile(path, 'not json {');
    await expect(store.read()).resolves.toEqual({});
  });

  it('write refuses an invalid configuration (belt-and-braces re-parse)', async () => {
    const { store } = await tempStore();
    await expect(
      store.write({ claude: { kind: 'flat', feeMicros: '1.5', periodDays: 30 } } as PricingReference),
    ).rejects.toThrow();
  });
});

describe('schemas', () => {
  it('accepts "0" as a valid micros string (never truthy-coerce a micros value)', () => {
    expect(
      BillingShapeSchema.safeParse({
        kind: 'flat',
        feeMicros: '0',
        periodDays: 1,
        altMeteredPriceMicrosPerUnit: '0',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['negative money', { kind: 'flat', feeMicros: '-5', periodDays: 30 }],
    ['decimal money', { kind: 'flat', feeMicros: '1.5', periodDays: 30 }],
    ['number money (bigint never transits JSON as a number)', { kind: 'flat', feeMicros: 5, periodDays: 30 }],
    ['zero periodDays', { kind: 'flat', feeMicros: '5', periodDays: 0 }],
    ['fractional periodDays', { kind: 'flat', feeMicros: '5', periodDays: 7.5 }],
    ['unknown kind', { kind: 'per-seat', feeMicros: '5', periodDays: 30 }],
  ])('rejects %s', (_label, shape) => {
    expect(BillingShapeSchema.safeParse(shape).success).toBe(false);
  });

  it('rejects a document whose value is not a billing shape', () => {
    expect(PricingReferenceSchema.safeParse({ claude: 'flat' }).success).toBe(false);
    expect(PricingReferenceSchema.safeParse([]).success).toBe(false);
    expect(PricingReferenceSchema.safeParse(null).success).toBe(false);
  });

  it('rejects an empty-string provider id (would alias NULL-provider/unattributed rows)', () => {
    expect(
      PricingReferenceSchema.safeParse({
        '': { kind: 'flat', feeMicros: '30000000', periodDays: 30 },
      }).success,
    ).toBe(false);
  });
});
