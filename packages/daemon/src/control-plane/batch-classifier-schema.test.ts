import { describe, expect, it } from 'vitest';
import {
  BatchClassificationItemSchema,
  BatchClassificationResponseSchema,
  batchClassificationJsonSchema,
} from './batch-classifier-schema.js';

describe('batch classifier schema (#470)', () => {
  it('accepts classifier items with issue numbers', () => {
    const parsed = BatchClassificationItemSchema.safeParse({
      issueNumber: 42,
      complexity: 'standard',
      reasoning: 'Multiple coordinated files',
      estimatedUnits: 3,
      estimatedArtifacts: 5,
    });

    expect(parsed.success).toBe(true);
  });

  it('validates batch output as an object with a classifications array', () => {
    const parsed = BatchClassificationResponseSchema.safeParse({
      classifications: [
        {
          issueNumber: 1,
          complexity: 'simple',
          reasoning: 'Small fix',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('exports a draft-07 OBJECT JSON schema for the CLI adapter (a tool input_schema.type must be object, never array)', () => {
    const schema = JSON.parse(batchClassificationJsonSchema) as Record<
      string,
      unknown
    >;

    expect(schema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    });
    expect(JSON.stringify(schema)).toContain('classifications');
    expect(JSON.stringify(schema)).toContain('issueNumber');
  });
});
