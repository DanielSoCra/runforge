/**
 * STACK-AC-SPEND-OBSERVABILITY — the control-plane Spend API handlers.
 *
 * Thin `{ status, body }` adapters over the pure `SpendReadModel` and the
 * `PricingReferenceStore` — the operator-surface-api split (decision in a pure
 * function, I/O at the edge) reused verbatim from `../decision-api.ts`. Each
 * handler takes its injected NARROW dependency plus the raw request pieces,
 * Zod-validates at the boundary (400 on malformed BEFORE any Store read or
 * write), and never rethrows: the typed `SpendUnavailableError` (the Store's
 * already-categorized unavailable outcome) maps to 503 with the category
 * logged, so a wired route can never crash the control server and the spend
 * surface degrades while every other Control-Plane route keeps serving.
 *
 * `503` is "records unavailable", NEVER "spend is zero" — an empty period is
 * a zeroed `200` from the read model (the success state, not an error).
 *
 * READ-ONLY authority throughout, except `setPricingReference` — which
 * persists Operator configuration that re-values ESTIMATES on the next read
 * and never touches a recorded actual.
 */
import { z } from 'zod';
import type { ErrorBody, HandlerResult } from '../decision-api.js';
import type { AltPriceOverrides, SpendReadModel } from './read-model.js';
import {
  PricingReferenceSchema,
  type PricingReference,
  type PricingReferenceStore,
} from './pricing-reference.js';
import {
  SpendUnavailableError,
  type PeriodAggregate,
  type PeriodQuery,
  type ProjectSpendBody,
  type ProviderSplitBody,
  type SavingsBody,
} from './types.js';

// ── period-query parsing (Zod at the boundary) ───────────────────────────────

const NamedPeriodSchema = z.enum(['today', '7d', '30d']);

/** An ISO-8601 timestamp that `new Date(...)` accepts. */
const IsoDate = z
  .string()
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), { message: 'invalid date' });

const RawPeriodQuerySchema = z.union([
  z.object({ period: NamedPeriodSchema, from: z.undefined(), to: z.undefined() }),
  z
    .object({ period: z.undefined(), from: IsoDate, to: IsoDate })
    .refine((range) => range.from.getTime() < range.to.getTime(), {
      message: 'from must precede to',
    }),
]);

/**
 * Parse `?period=today|7d|30d` OR `?from=<iso>&to=<iso>` (exactly one form)
 * into a validated `PeriodQuery`. `null` = malformed → the caller's 400.
 * No parameters at all defaults to the last 30 days (a benign read default,
 * mirroring the L1's named-period examples).
 */
export function parsePeriodQuery(params: URLSearchParams): PeriodQuery | null {
  const period = params.get('period') ?? undefined;
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  if (period === undefined && from === undefined && to === undefined) {
    return { kind: 'named', period: '30d' };
  }
  const parsed = RawPeriodQuerySchema.safeParse({ period, from, to });
  if (!parsed.success) return null;
  if (parsed.data.period !== undefined) {
    return { kind: 'named', period: parsed.data.period };
  }
  return { kind: 'custom', from: parsed.data.from, to: parsed.data.to };
}

/** `alt=<providerId>:<microsPerUnit>` (repeatable) → per-read overrides. `null` = malformed. */
export function parseAltOverrides(params: URLSearchParams): AltPriceOverrides | null {
  const overrides: AltPriceOverrides = {};
  for (const raw of params.getAll('alt')) {
    const separator = raw.lastIndexOf(':');
    if (separator <= 0) return null;
    const provider = raw.slice(0, separator);
    const micros = raw.slice(separator + 1);
    if (!/^\d+$/.test(micros)) return null;
    overrides[provider] = micros;
  }
  return overrides;
}

// ── shared fail-safe mapping ─────────────────────────────────────────────────

const MALFORMED_PERIOD: HandlerResult<ErrorBody> = {
  status: 400,
  body: { error: 'invalid period: use period=today|7d|30d or from=<iso>&to=<iso>' },
};

/** Map any read-path throw to 503 (log the Store's category when typed). Never rethrows. */
function unavailableResult(route: string, e: unknown): HandlerResult<ErrorBody> {
  if (e instanceof SpendUnavailableError) {
    console.error(`[spend-api] ${route}: spend records unavailable (${e.category}): ${e.message}`);
  } else {
    console.error(`[spend-api] ${route} failed:`, e);
  }
  return { status: 503, body: { error: 'spend records unavailable' } };
}

// ── read handlers ────────────────────────────────────────────────────────────

/** GET /spend/period — the unified headline: totals, provider split, deltas, Currency Marker. */
export async function listPeriodSpend(
  readModel: SpendReadModel,
  params: URLSearchParams,
): Promise<HandlerResult<PeriodAggregate | ErrorBody>> {
  const query = parsePeriodQuery(params);
  if (query === null) return MALFORMED_PERIOD;
  try {
    return { status: 200, body: await readModel.headline(query) };
  } catch (e: unknown) {
    return unavailableResult('GET /spend/period', e);
  }
}

/** GET /spend/by-project — projects ranked by spend + the explicit unattributed row. */
export async function spendByProject(
  readModel: SpendReadModel,
  params: URLSearchParams,
): Promise<HandlerResult<ProjectSpendBody | ErrorBody>> {
  const query = parsePeriodQuery(params);
  if (query === null) return MALFORMED_PERIOD;
  try {
    return { status: 200, body: await readModel.byProject(query) };
  } catch (e: unknown) {
    return unavailableResult('GET /spend/by-project', e);
  }
}

/** GET /spend/provider-split — each provider's share of money and usage, distinctly. */
export async function providerSplit(
  readModel: SpendReadModel,
  params: URLSearchParams,
): Promise<HandlerResult<ProviderSplitBody | ErrorBody>> {
  const query = parsePeriodQuery(params);
  if (query === null) return MALFORMED_PERIOD;
  try {
    return { status: 200, body: await readModel.providerSplit(query) };
  } catch (e: unknown) {
    return unavailableResult('GET /spend/provider-split', e);
  }
}

/**
 * GET /spend/savings — the flat-vs-metered comparison. An optional repeatable
 * `alt=<providerId>:<micros>` override re-values THIS read only (per L2) and
 * is never persisted to the PricingReference.
 */
export async function savingsComparison(
  readModel: SpendReadModel,
  params: URLSearchParams,
): Promise<HandlerResult<SavingsBody | ErrorBody>> {
  const query = parsePeriodQuery(params);
  if (query === null) return MALFORMED_PERIOD;
  const overrides = parseAltOverrides(params);
  if (overrides === null) {
    return {
      status: 400,
      body: { error: 'invalid alt override: use alt=<providerId>:<microsPerUnit>' },
    };
  }
  try {
    return { status: 200, body: await readModel.savings(query, overrides) };
  } catch (e: unknown) {
    return unavailableResult('GET /spend/savings', e);
  }
}

// ── PricingReference handlers ────────────────────────────────────────────────

/** GET /spend/pricing-reference — the current Operator-owned billing shapes. */
export async function readPricingReference(
  store: PricingReferenceStore,
): Promise<HandlerResult<PricingReference | ErrorBody>> {
  try {
    return { status: 200, body: await store.read() };
  } catch (e: unknown) {
    return unavailableResult('GET /spend/pricing-reference', e);
  }
}

/**
 * PUT /spend/pricing-reference — replace the configuration. The body is
 * Zod-validated BEFORE persisting (400 on malformed, so a bad shape can never
 * corrupt a later estimate); a valid set re-values estimates on the next read
 * and never touches a recorded actual.
 */
export async function setPricingReference(
  store: PricingReferenceStore,
  body: unknown,
): Promise<HandlerResult<PricingReference | ErrorBody>> {
  const parsed = PricingReferenceSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'malformed pricing reference: billing shapes must be metered or flat with decimal-integer micro-unit strings' },
    };
  }
  try {
    await store.write(parsed.data);
    return { status: 200, body: parsed.data };
  } catch (e: unknown) {
    return unavailableResult('PUT /spend/pricing-reference', e);
  }
}
