// packages/daemon/src/control-plane/lane-engine/schema.ts
import { z } from 'zod';
import type { LaneSet } from './types.js';

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

const BatchReviewPolicy = z.object({ enabled: z.boolean(), cadence: z.string() });
const EarnInPolicy = z.object({
  cleanMerges: z.number().int().min(0),
  bounceFreeDays: z.number().int().min(0),
});

const LaneDefinitionSchema = z.object({
  name: z.string().min(1),
  qualify: z.object({
    complexity: z.array(Complexity).optional(),
    changeKind: z.array(ChangeKind).optional(),
  }),
  allowedPaths: z.array(z.string()).min(1),
  roleRouting: z.record(z.string(), z.string()),
  gateSet: byMode(z.string()),
  mergePolicy: byMode(MergePolicy),
  postMergeReview: BatchReviewPolicy.optional(),
  earnIn: EarnInPolicy.optional(),
});

const LaneSetSchema = z.object({
  lanes: z.array(LaneDefinitionSchema).min(1),
  mostCautiousLane: z.string().min(1),
  declaredPhases: z.array(z.string()).min(1),
});

export type ParseLaneSetResult =
  | { ok: true; laneSet: Readonly<LaneSet> }
  | { ok: false; errors: string[] };

function isModeMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

  for (const lane of data.lanes) {
    const gsMap = isModeMap(lane.gateSet);
    const mpMap = isModeMap(lane.mergePolicy);
    if (gsMap !== mpMap) {
      errors.push(
        `lane '${lane.name}': gateSet and mergePolicy must be coherent — either both per-mode maps or both plain values`,
      );
    }
    if (gsMap && mpMap) {
      const gsKeys = Object.keys(lane.gateSet as Record<string, unknown>);
      const mpKeys = Object.keys(lane.mergePolicy as Record<string, unknown>);
      for (const key of [...gsKeys, ...mpKeys]) {
        if (!phases.has(key)) {
          errors.push(`lane '${lane.name}': per-mode field references undeclared phase '${key}'`);
        }
      }
      if (gsKeys.length !== mpKeys.length || gsKeys.some((k) => !mpKeys.includes(k))) {
        errors.push(`lane '${lane.name}': gateSet and mergePolicy must declare the same phases`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, laneSet: Object.freeze(data) as Readonly<LaneSet> };
}
