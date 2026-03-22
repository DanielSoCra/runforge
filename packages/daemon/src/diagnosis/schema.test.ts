import { describe, it, expect } from 'vitest';
import { BugDiagnosisSchema, bugDiagnosisJsonSchema } from './schema.js';

const validInput = {
  type: 'A' as const,
  confidence: 0.85,
  affectedSpecs: ['STACK-AC-DIAGNOSIS'],
  affectedArtifacts: [],
  suggestedAction: 'Fix the implementation',
  reasoning: 'The bug is clearly in the code',
};

describe('BugDiagnosisSchema', () => {
  it('validates correct input with affectedSpecs', () => {
    const result = BugDiagnosisSchema.safeParse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('A');
      expect(result.data.confidence).toBe(0.85);
    }
  });

  it('validates correct input with affectedArtifacts only', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      affectedSpecs: [],
      affectedArtifacts: ['src/diagnosis/schema.ts'],
    });
    expect(result.success).toBe(true);
  });

  it('validates correct input with both specs and artifacts', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      affectedSpecs: ['STACK-AC-DIAGNOSIS'],
      affectedArtifacts: ['src/diagnosis/schema.ts'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects when both affectedSpecs and affectedArtifacts are empty', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      affectedSpecs: [],
      affectedArtifacts: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'At least one affected spec or artifact required',
      );
    }
  });

  it('rejects confidence below 0', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence above 1', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts confidence of exactly 0', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      confidence: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts confidence of exactly 1', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      confidence: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid type "D"', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      type: 'D',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type (empty string)', () => {
    const result = BugDiagnosisSchema.safeParse({
      ...validInput,
      type: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('bugDiagnosisJsonSchema', () => {
  it('is a valid JSON string', () => {
    expect(() => JSON.parse(bugDiagnosisJsonSchema)).not.toThrow();
  });

  it('contains type field', () => {
    const schema = JSON.parse(bugDiagnosisJsonSchema) as Record<string, unknown>;
    expect(JSON.stringify(schema)).toContain('type');
  });

  it('produces draft-07 JSON Schema, not draft-2020-12 (#120)', () => {
    const schema = JSON.parse(bugDiagnosisJsonSchema) as Record<string, unknown>;
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });
});
