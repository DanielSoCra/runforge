// packages/daemon/src/compliance/evaluator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { evaluateCompliance } from './evaluator.js';

const now = new Date().toISOString();

function pass(roleId: string) {
  return {
    reviewerRoleId: roleId,
    verdict: 'pass' as const,
    reason: '',
    timestamp: now,
  };
}

function block(roleId: string, reason: string) {
  return {
    reviewerRoleId: roleId,
    verdict: 'block' as const,
    reason,
    timestamp: now,
  };
}

describe('evaluateCompliance', () => {
  it('proceeds when no regulated paths are configured', () => {
    const result = evaluateCompliance({
      profile: { regulatedPaths: [] },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('proceed');
    expect(result.requiredReviewers).toEqual([]);
  });

  it('proceeds when touched paths do not match regulated patterns', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
        ],
      },
      touchedPaths: ['packages/core/util.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('proceed');
    expect(result.matchedPaths).toEqual([]);
  });

  it('proceeds when all required reviewers passed', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/auth/**', requiredReviewers: ['security-compliance', 'privacy-compliance'] },
        ],
      },
      touchedPaths: ['packages/auth/session.ts'],
      verdicts: {
        'security-compliance': pass('security-compliance'),
        'privacy-compliance': pass('privacy-compliance'),
      },
    });
    expect(result.status).toBe('proceed');
    expect(result.reasons[0]).toContain('all required compliance reviews passed');
  });

  it('holds when a required review is missing', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
        ],
      },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('hold');
    expect(result.missingReviewers).toContain('billing-compliance');
  });

  it('blocks when a required reviewer returns block', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
        ],
      },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {
        'billing-compliance': block('billing-compliance', 'Incorrect tax calculation'),
      },
    });
    expect(result.status).toBe('blocked');
    expect(result.blockingReviewers).toContain('billing-compliance');
  });

  it('unions required reviewers across multiple matched paths', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
          { pattern: 'packages/auth/**', requiredReviewers: ['security-compliance'] },
        ],
      },
      touchedPaths: ['packages/billing/invoice.ts', 'packages/auth/session.ts'],
      verdicts: {
        'billing-compliance': pass('billing-compliance'),
      },
    });
    expect(result.status).toBe('hold');
    expect(result.requiredReviewers).toEqual(['billing-compliance', 'security-compliance']);
  });

  it('deduplicates reviewers required by multiple paths', () => {
    const result = evaluateCompliance({
      profile: {
        regulatedPaths: [
          { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
          { pattern: 'packages/billing/taxes/**', requiredReviewers: ['billing-compliance'] },
        ],
      },
      touchedPaths: ['packages/billing/taxes/vat.ts'],
      verdicts: {
        'billing-compliance': pass('billing-compliance'),
      },
    });
    expect(result.status).toBe('proceed');
    expect(result.requiredReviewers).toEqual(['billing-compliance']);
  });

  // FAIL-CLOSED regression (#779): a malformed/incomplete profile must BLOCK
  // (hold for a human), never silently degrade to an empty "proceed". The old
  // behavior normalized an unparseable profile to `{ regulatedPaths: [] }` and
  // returned `proceed` — a fail-OPEN bypass of the gate.
  it('BLOCKS (fail-closed) when regulatedPaths is present but not an array', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateCompliance({
      profile: { regulatedPaths: 'not-an-array' },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('blocked');
    expect(result.reasons[0]).toContain('invalid or incomplete compliance profile');
    consoleSpy.mockRestore();
  });

  it('BLOCKS (fail-closed) when a regulatedPaths entry has an empty pattern', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateCompliance({
      profile: { regulatedPaths: [{ pattern: '', requiredReviewers: ['x'] }] },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('blocked');
    consoleSpy.mockRestore();
  });

  it('BLOCKS (fail-closed) when the profile is an unparseable non-object', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateCompliance({
      profile: 'totally-not-a-profile',
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('blocked');
    consoleSpy.mockRestore();
  });

  it('still PROCEEDS for a valid empty profile (no compliance configured)', () => {
    const result = evaluateCompliance({
      profile: { regulatedPaths: [] },
      touchedPaths: ['packages/billing/invoice.ts'],
      verdicts: {},
    });
    expect(result.status).toBe('proceed');
  });
});
