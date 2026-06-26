import { z } from 'zod';

export const UnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  specIds: z.array(z.string()),
  specContent: z.string(),
  expectedArtifacts: z.array(z.string()),
  dependencies: z.array(z.string()),
  batchNumber: z.number().int(),
  verificationCommand: z.string(),
  context: z.string(),
  estimatedChangeSize: z.number().optional(),
});

// The coordinator emits ONLY { units }; decompose.ts injects issueNumber/featureBranch.
export const TaskGraphInputSchema = z.object({ units: z.array(UnitSchema) });

// target:'draft-07' for CLI --json-schema compatibility (same gotcha as classifier).
export const taskGraphJsonSchema = JSON.stringify(
  z.toJSONSchema(TaskGraphInputSchema, { target: 'draft-07' }),
);
