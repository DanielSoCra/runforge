/**
 * STACK-AC-SPEND-OBSERVABILITY — the Operator-owned PricingReference.
 *
 * The ONE new persistent thing this projection introduces (L2 Data Model): a
 * per-deployment JSON config (`state/pricing-reference.json`) declaring each
 * provider's billing shape — `metered` (cost events already carry money) or
 * `flat` (a subscription fee over a subscription period, with an optional
 * alternative metered price at which its usage is ESTIMATED). It values
 * estimates only and never touches a recorded actual.
 *
 * Zod is the single source of shape truth (STACK-AC-CONVENTIONS): the same
 * schema validates the stored JSON on read and the PUT body at the handler
 * boundary (400 on malformed BEFORE persisting, so a bad shape can never
 * corrupt a later estimate). Money fields are decimal-integer strings of
 * micro-units — `bigint` is neither JSON-serializable nor present in a JSON
 * body; parsing to `bigint` happens only inside the read model.
 *
 * Writes go through `writeJsonSafe` (atomic tmp-file + rename, the repo's
 * state/*.json convention); a missing or invalid file on the READ path is the
 * empty configuration (all providers default to metered), logged, never a
 * throw — pricing is an estimate knob, not operational truth.
 */
import { z } from 'zod';
import { readJsonSafe, writeJsonSafe } from '../../lib/json-store.js';

/** Non-negative integer micro-units as a decimal string — JSON-safe, parsed to `bigint` internally. */
export const MicrosSchema = z.string().regex(/^\d+$/);

/** A provider's billing shape: metered (events carry money) or flat (subscription). */
export const BillingShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metered') }),
  z.object({
    kind: z.literal('flat'),
    feeMicros: MicrosSchema,
    periodDays: z.number().int().positive(),
    altMeteredPriceMicrosPerUnit: MicrosSchema.optional(),
  }),
]);

/**
 * The whole PricingReference document: billing shape keyed by provider id.
 * Provider ids must be non-empty — an empty key would alias NULL-provider
 * (unattributed) cost rows, revaluing spend the reference has no claim on.
 */
export const PricingReferenceSchema = z.record(z.string().min(1), BillingShapeSchema);

export type BillingShape = z.infer<typeof BillingShapeSchema>;
export type PricingReference = z.infer<typeof PricingReferenceSchema>;

/** Providers with no PricingReference entry default to this shape (cost is recorded truth). */
export const DEFAULT_BILLING_SHAPE: BillingShape = { kind: 'metered' };

/**
 * The per-deployment JSON config store. Read is fail-open to the EMPTY
 * configuration (missing/corrupt file → `{}` + warn — estimates degrade,
 * nothing crashes); write is validate-then-atomic-rename.
 */
export class PricingReferenceStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** Current configuration; `{}` when the file is missing or malformed (logged). */
  async read(): Promise<PricingReference> {
    const raw = await readJsonSafe<unknown>(this.#path);
    if (!raw.ok) return {}; // missing file — the default (empty) configuration
    const parsed = PricingReferenceSchema.safeParse(raw.value);
    if (!parsed.success) {
      console.warn(
        `[spend] pricing reference at ${this.#path} is malformed; using the empty configuration`,
      );
      return {};
    }
    return parsed.data;
  }

  /**
   * Persist a NEW configuration atomically. The caller (the PUT handler) has
   * already Zod-validated the value — this re-parse is belt-and-braces so no
   * unvalidated object can ever reach the file.
   */
  async write(reference: PricingReference): Promise<void> {
    const parsed = PricingReferenceSchema.parse(reference);
    await writeJsonSafe(this.#path, parsed);
  }
}
