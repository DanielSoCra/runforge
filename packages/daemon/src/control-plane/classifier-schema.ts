import { z } from 'zod';

// Lane-engine ChangeKind vocabulary (Plan-2). Kept in lockstep with
// ../lane-engine/types.ts ChangeKind so the classifier verdict can be matched
// against a lane's `qualify.changeKind` without a translation layer.
export const ChangeKindSchema = z.enum([
  'docs',
  'formatting',
  'dependency-refresh',
  'feature',
  'fix',
  'refactor',
  'config',
  'other',
]);

export const ClassificationSchema = z.object({
  complexity: z.enum(['simple', 'standard', 'complex']),
  reasoning: z.string(),
  estimatedUnits: z.number().int().min(1),
  estimatedArtifacts: z.number().int().min(0),
  // Plan-2 lane-engine extension — OPTIONAL + additive so existing classifier
  // output (no changeKind/scope) still parses. The lane engine matches these
  // against each lane's `qualify`; an absent field simply does not narrow.
  changeKind: ChangeKindSchema.optional(),
  scope: z.string().optional(),
});

export type ClassificationResult = z.infer<typeof ClassificationSchema>;

// target: 'draft-07' ensures CLI adapter compatibility (spec gotcha: --json-schema requires draft-07).
export const classificationJsonSchema = JSON.stringify(
  z.toJSONSchema(ClassificationSchema, { target: 'draft-07' }),
);
