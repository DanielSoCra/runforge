// packages/daemon/src/compliance/schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  ComplianceProfileSchema,
  ComplianceReviewVerdictSchema,
  ComplianceEvaluationSchema,
} from './schemas.js';

describe('ComplianceProfileSchema', () => {
  it('accepts a valid profile', () => {
    const result = ComplianceProfileSchema.safeParse({
      regulatedPaths: [
        { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults regulatedPaths to empty array', () => {
    const result = ComplianceProfileSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.regulatedPaths).toEqual([]);
    }
  });
});

describe('ComplianceReviewVerdictSchema', () => {
  it('accepts a valid pass verdict', () => {
    const result = ComplianceReviewVerdictSchema.safeParse({
      reviewerRoleId: 'billing-compliance',
      verdict: 'pass',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid verdict', () => {
    const result = ComplianceReviewVerdictSchema.safeParse({
      reviewerRoleId: 'billing-compliance',
      verdict: 'pending',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('ComplianceEvaluationSchema', () => {
  it('accepts a proceed evaluation', () => {
    const result = ComplianceEvaluationSchema.safeParse({
      status: 'proceed',
      matchedPaths: [],
      requiredReviewers: [],
      verdicts: {},
    });
    expect(result.success).toBe(true);
  });
});
