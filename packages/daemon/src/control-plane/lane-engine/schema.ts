// packages/daemon/src/control-plane/lane-engine/schema.ts
import { z } from 'zod';
import type { LaneSet } from './types.js';
import { VerifierDeclarationSchema } from './verifier-gate/schema.js';

const Complexity = z.enum(['simple', 'standard', 'complex']);
const ChangeKind = z.enum([
  'docs',
  'formatting',
  'dependency-refresh',
  'feature',
  'fix',
  'refactor',
  'config',
  'other',
]);
const MergePolicy = z.enum(['auto', 'review-then-auto', 'hold']);

/** A field that is either a single value or a per-phase map. */
const byMode = <T extends z.ZodTypeAny>(value: T) => z.union([value, z.record(z.string(), value)]);

// All object schemas are .strict(): unknown keys are REJECTED, never silently
// stripped — a typo'd qualifier (e.g. `changeKinds`) must fail pack activation
// rather than collapse a lane into an unintended catch-all (fail-closed).
const BatchReviewPolicy = z.object({ enabled: z.boolean(), cadence: z.string() }).strict();
const EarnInPolicy = z
  .object({
    cleanMerges: z.number().int().min(0),
    bounceFreeDays: z.number().int().min(0),
  })
  .strict();

const PreApprovedEarnIn = z
  .object({
    enabled: z.boolean(),
    policyRef: z.string().min(1),
  })
  .strict();

const LaneDefinitionSchema = z
  .object({
    name: z.string().min(1),
    // Qualification matches on complexity, changeKind, and declared scope —
    // the L2/L3 qualify contract. scope values are deployment-defined categories
    // (free strings) emitted by the Plan-2 classifier extension; the contract
    // lives here so packs can declare scope-specific lanes.
    qualify: z
      .object({
        // .min(1): an empty array makes the lane unreachable (no verdict can
        // satisfy it) — that is a config error, not a valid catch-all.
        complexity: z.array(Complexity).min(1).optional(),
        changeKind: z.array(ChangeKind).min(1).optional(),
        scope: z.array(z.string()).min(1).optional(),
      })
      .strict(),
    allowedPaths: z.array(z.string()).min(1),
    roleRouting: z.record(z.string(), z.string()),
    gateSet: byMode(z.string()),
    mergePolicy: byMode(MergePolicy),
    postMergeReview: BatchReviewPolicy.optional(),
    earnIn: EarnInPolicy.optional(),
    preApprovedEarnIn: PreApprovedEarnIn.optional(),
    // The lane's optional falsifiable-oracle declaration (verifier-gate's own
    // .strict() schema). A lane without it can never earn auto-merge — the
    // merge-decision gate escalates `verifier-withheld`.
    verifier: VerifierDeclarationSchema.optional(),
  })
  .strict();

const LaneSetSchema = z
  .object({
    lanes: z.array(LaneDefinitionSchema).min(1),
    mostCautiousLane: z.string().min(1),
    declaredPhases: z.array(z.string()).min(1),
  })
  .strict();

export type ParseLaneSetResult =
  | { ok: true; laneSet: Readonly<LaneSet> }
  | { ok: false; errors: string[] };

function isModeMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Two value-sets are compatible if either is unconstrained (undefined) or they intersect. */
function dimsCompatible<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a.some((x) => b.includes(x));
}

/**
 * Two lane qualifications overlap when some classifier verdict could satisfy
 * both — i.e. they are compatible on every dimension. Assignment requires
 * exactly one match, so overlapping lanes make one unreachable; the schema
 * rejects overlaps at activation rather than silently routing to mostCautious.
 */
function qualificationsOverlap(
  a: { complexity?: string[]; changeKind?: string[]; scope?: string[] },
  b: { complexity?: string[]; changeKind?: string[]; scope?: string[] },
): boolean {
  return (
    dimsCompatible(a.complexity, b.complexity) &&
    dimsCompatible(a.changeKind, b.changeKind) &&
    dimsCompatible(a.scope, b.scope)
  );
}

/** Recursively freeze an object graph so a parsed LaneSet cannot be mutated post-validation. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate raw config-pack lane data at pack-activation time. On any error the
 * result is `ok: false` with messages — the caller keeps the previous pack
 * (atomic activation). On success the lane set is deep-frozen.
 */
export function parseLaneSet(raw: unknown): ParseLaneSetResult {
  const parsed = LaneSetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const data = parsed.data;
  const errors: string[] = [];
  const phases = new Set(data.declaredPhases);

  if (!data.lanes.some((l) => l.name === data.mostCautiousLane)) {
    errors.push(`mostCautiousLane '${data.mostCautiousLane}' is not a declared lane`);
  }

  // Lane names must be unique: assignment and audit records persist only the
  // name, so a duplicate makes a recorded assignment ambiguous.
  const seenNames = new Set<string>();
  for (const lane of data.lanes) {
    if (seenNames.has(lane.name)) {
      errors.push(`duplicate lane name '${lane.name}' — lane names must be unique`);
    }
    seenNames.add(lane.name);
  }

  // gateSet and mergePolicy may EACH independently be a single value or a
  // per-mode map (the L2/L3 byMode contract — no cross-field coherence rule).
  // For each field that is a map: its phases must be declared, and it must cover
  // EVERY declared phase, so a known mode never silently falls through to
  // another phase's policy.
  for (const lane of data.lanes) {
    for (const [fieldName, field] of [
      ['gateSet', lane.gateSet],
      ['mergePolicy', lane.mergePolicy],
    ] as const) {
      if (!isModeMap(field)) continue;
      const keys = Object.keys(field);
      for (const key of keys) {
        if (!phases.has(key)) {
          errors.push(`lane '${lane.name}': ${fieldName} references undeclared phase '${key}'`);
        }
      }
      for (const phase of data.declaredPhases) {
        if (!keys.includes(phase)) {
          errors.push(`lane '${lane.name}': ${fieldName} must cover declared phase '${phase}'`);
        }
      }
    }
  }

  // Lane qualifications must be pairwise non-overlapping — assignment requires
  // exactly one match, so an overlap makes a lane unreachable (a catch-all lane
  // plus any specific lane is the common trap).
  for (let i = 0; i < data.lanes.length; i++) {
    for (let j = i + 1; j < data.lanes.length; j++) {
      const a = data.lanes[i]!;
      const b = data.lanes[j]!;
      if (qualificationsOverlap(a.qualify, b.qualify)) {
        errors.push(
          `lanes '${a.name}' and '${b.name}' have overlapping qualifications — a change could match both, making one unreachable`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, laneSet: deepFreeze(data) as Readonly<LaneSet> };
}
