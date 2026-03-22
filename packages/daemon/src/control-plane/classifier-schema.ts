import { z } from 'zod';

export const ClassificationSchema = z.object({
  complexity: z.enum(['simple', 'standard', 'complex']),
  reasoning: z.string(),
  estimatedUnits: z.number().int().min(1),
  estimatedArtifacts: z.number().int().min(0),
});

export type ClassificationResult = z.infer<typeof ClassificationSchema>;

// target: 'draft-07' ensures CLI adapter compatibility (spec gotcha: --json-schema requires draft-07).
export const classificationJsonSchema = JSON.stringify(
  z.toJSONSchema(ClassificationSchema, { target: 'draft-07' }),
);
