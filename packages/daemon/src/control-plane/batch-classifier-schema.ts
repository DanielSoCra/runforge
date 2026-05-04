import { z } from 'zod';
import { ClassificationSchema } from './classifier-schema.js';

export const BatchClassificationItemSchema = ClassificationSchema.extend({
  issueNumber: z.number().int().min(1),
});

export const BatchClassificationResponseSchema = z.array(
  BatchClassificationItemSchema,
);

export type BatchClassificationItem = z.infer<
  typeof BatchClassificationItemSchema
>;

// target: 'draft-07' ensures CLI adapter compatibility (spec gotcha: --json-schema requires draft-07).
export const batchClassificationJsonSchema = JSON.stringify(
  z.toJSONSchema(BatchClassificationResponseSchema, { target: 'draft-07' }),
);
