// finding-dismissal/labels.test.ts — the SHARED parser contract (PR1).
// Pure: string in, enum/string out. No GitHub, no clock, no ledger.
import { describe, it, expect } from 'vitest';
import {
  REVIEW_CATEGORIES,
  isReviewCategory,
  parseCategory,
  hasHumanRoute,
  HUMAN_ROUTE_LABEL,
  isGuardedFindingCategory,
  GUARDED_FINDING_CATEGORIES,
  findingDismissalClass,
  verdictLabelFor,
  KEPT_LABEL,
  DISMISSED_LABEL,
  parseSeverityRiskClass,
  DEFAULT_FINDING_RISK_CLASS,
} from './labels.js';

describe('parseCategory (strict, exactly-one)', () => {
  it('returns the single category when exactly one is present', () => {
    expect(parseCategory(['review-finding', 'correctness', 'P1'])).toBe('correctness');
    for (const c of REVIEW_CATEGORIES) {
      expect(parseCategory(['review-finding', c])).toBe(c);
    }
  });

  it('returns null when NO category label is present (no-emit, never uncategorized)', () => {
    expect(parseCategory(['review-finding', 'P1', 'needs-discussion'])).toBeNull();
    expect(parseCategory([])).toBeNull();
  });

  it('returns null for an unknown / unrelated label', () => {
    expect(parseCategory(['review-finding', 'correctnesss'])).toBeNull();
    expect(parseCategory(['Correctness'])).toBeNull(); // case-sensitive
    expect(parseCategory(['bug', 'enhancement'])).toBeNull();
  });

  it('returns null when MORE than one category is present (ambiguous)', () => {
    expect(parseCategory(['correctness', 'security'])).toBeNull();
  });

  it('treats a duplicated single category as one (not ambiguous)', () => {
    expect(parseCategory(['correctness', 'correctness'])).toBe('correctness');
  });
});

describe('isReviewCategory', () => {
  it('accepts the fixed set and rejects everything else', () => {
    expect(isReviewCategory('security')).toBe(true);
    expect(isReviewCategory('test-gaps')).toBe(true);
    expect(isReviewCategory('flakiness')).toBe(false);
    expect(isReviewCategory('')).toBe(false);
  });
});

describe('hasHumanRoute', () => {
  it('detects the needs-discussion human-route label', () => {
    expect(HUMAN_ROUTE_LABEL).toBe('needs-discussion');
    expect(hasHumanRoute(['review-finding', 'needs-discussion'])).toBe(true);
    expect(hasHumanRoute(['review-finding', 'correctness'])).toBe(false);
  });
});

describe('guarded categories', () => {
  it('security is guarded by default; others are not', () => {
    expect(GUARDED_FINDING_CATEGORIES.has('security')).toBe(true);
    expect(isGuardedFindingCategory('security')).toBe(true);
    expect(isGuardedFindingCategory('correctness')).toBe(false);
    expect(isGuardedFindingCategory('performance')).toBe(false);
  });

  it('findingDismissalClass(security) === the guarded learning-class string', () => {
    expect(findingDismissalClass('security')).toBe('finding_dismissal:security');
    expect(findingDismissalClass('correctness')).toBe('finding_dismissal:correctness');
  });
});

describe('verdict labels', () => {
  it('approve → kept, reject → dismissed', () => {
    expect(KEPT_LABEL).toBe('kept');
    expect(DISMISSED_LABEL).toBe('dismissed');
    expect(verdictLabelFor('approve')).toBe('kept');
    expect(verdictLabelFor('reject')).toBe('dismissed');
  });
});

describe('parseSeverityRiskClass', () => {
  it('maps a P0..P3 severity label to the risk class', () => {
    expect(parseSeverityRiskClass(['review-finding', 'P0', 'correctness'])).toBe('P0');
    expect(parseSeverityRiskClass(['P3'])).toBe('P3');
  });

  it('falls back to the cautious default when no severity label is present', () => {
    expect(DEFAULT_FINDING_RISK_CLASS).toBe('P2');
    expect(parseSeverityRiskClass(['review-finding', 'correctness'])).toBe('P2');
  });
});
