import { z } from 'zod';
import { ClassificationSchema } from './classifier-schema.js';

export const BatchClassificationItemSchema = ClassificationSchema.extend({
  issueNumber: z.number().int().min(1),
});

// Object root (not a bare array): the Anthropic API requires a tool's
// input_schema.type to be "object", so a top-level z.array() produced via
// --json-schema yields an invalid tool ("tools.N.custom.input_schema.type:
// Input should be 'object'") and the whole classify call fails. Wrapping the
// array in an object keeps structured output valid AND enforced.
export const BatchClassificationResponseSchema = z.object({
  classifications: z.array(BatchClassificationItemSchema),
});

export type BatchClassificationItem = z.infer<
  typeof BatchClassificationItemSchema
>;

// target: 'draft-07' ensures CLI adapter compatibility (spec gotcha: --json-schema requires draft-07).
export const batchClassificationJsonSchema = JSON.stringify(
  z.toJSONSchema(BatchClassificationResponseSchema, { target: 'draft-07' }),
);
