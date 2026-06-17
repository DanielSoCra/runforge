// packages/daemon/src/control-plane/merge-decision/compliance.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateComplianceForced } from './compliance.js';
import type { ComplianceReviewer } from '../deployment-registry/types.js';

const reviewer = (condition: string): ComplianceReviewer => ({
  reviewer: 'clinical-lead',
  condition,
});

describe('evaluateComplianceForced', () => {
  it('forces when a touched path matches a reviewer condition glob', () => {
    expect(
      evaluateComplianceForced([reviewer('patient-data/**')], ['patient-data/record.ts']),
    ).toBe(true);
  });

  it('does NOT force when no touched path matches any condition', () => {
    expect(
      evaluateComplianceForced([reviewer('patient-data/**')], ['docs/readme.md']),
    ).toBe(false);
  });

  it('forces if ANY reviewer governs ANY touched path', () => {
    const reviewers = [reviewer('infra/**'), reviewer('billing/**')];
    expect(evaluateComplianceForced(reviewers, ['src/x.ts', 'billing/charge.ts'])).toBe(true);
  });

  it('no reviewers → never forced', () => {
    expect(evaluateComplianceForced([], ['patient-data/record.ts'])).toBe(false);
  });
});
