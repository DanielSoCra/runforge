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
  PROTECTION_LABELS,
  ROUTINE_VOCABULARY,
  explicitSeverity,
  isProtectedFinding,
  isRoutineFinding,
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

// ── PR3-pre: fail-closed protection / routine classifiers ─────────────────────

describe('explicitSeverity (exactly-one-or-null, fail-closed)', () => {
  it('returns the risk class ONLY when EXACTLY one severity label is present', () => {
    expect(explicitSeverity(['review-finding', 'correctness', 'P1'])).toBe('P1');
    expect(explicitSeverity(['P0'])).toBe('P0');
    expect(explicitSeverity(['review-finding', 'P3'])).toBe('P3');
  });

  it('returns null when NO severity label is present (uncertain, never the P2 default)', () => {
    expect(explicitSeverity(['review-finding', 'correctness'])).toBeNull();
    expect(explicitSeverity([])).toBeNull();
  });

  it('returns null when MULTIPLE severity labels are present (ambiguous)', () => {
    expect(explicitSeverity(['review-finding', 'P1', 'P2'])).toBeNull();
    expect(explicitSeverity(['P0', 'P3'])).toBeNull();
    expect(explicitSeverity(['P1', 'P1'])).toBeNull(); // even duplicates are ambiguous (fail-closed)
  });
});

describe('protection / routine vocabulary sets', () => {
  it('PROTECTION_LABELS carries the fixed protection set', () => {
    for (const l of [
      'compliance',
      'sensitive',
      'sensitive-data',
      'release',
      'production-release',
      'safety-critical',
      'spec-content',
    ]) {
      expect(PROTECTION_LABELS.has(l)).toBe(true);
    }
    expect(PROTECTION_LABELS.has('correctness')).toBe(false);
  });

  it('ROUTINE_VOCABULARY = review-finding + categories + risk classes + needs-discussion', () => {
    for (const l of ['review-finding', 'correctness', 'security', 'P0', 'P2', 'needs-discussion']) {
      expect(ROUTINE_VOCABULARY.has(l)).toBe(true);
    }
    expect(ROUTINE_VOCABULARY.has('compliance')).toBe(false);
    expect(ROUTINE_VOCABULARY.has('foo')).toBe(false);
  });
});

describe('isProtectedFinding (fail-closed)', () => {
  it('a guarded category (security) is protected', () => {
    expect(isProtectedFinding(['review-finding', 'security', 'P2'])).toBe(true);
  });

  it('the human-route (needs-discussion) is protected', () => {
    expect(isProtectedFinding(['review-finding', 'correctness', 'needs-discussion', 'P2'])).toBe(true);
  });

  it('ANY protection label forces protection', () => {
    for (const l of PROTECTION_LABELS) {
      expect(isProtectedFinding(['review-finding', 'correctness', 'P2', l])).toBe(true);
    }
  });

  it('a P0 (critical) severity is protected', () => {
    expect(isProtectedFinding(['review-finding', 'correctness', 'P0'])).toBe(true);
  });

  it('a MISSING severity is protected (uncertain)', () => {
    expect(isProtectedFinding(['review-finding', 'correctness'])).toBe(true);
  });

  it('MULTIPLE severity labels are protected (ambiguous)', () => {
    expect(isProtectedFinding(['review-finding', 'correctness', 'P1', 'P2'])).toBe(true);
  });

  it('a plain routine finding (single non-P0 severity, non-guarded) is NOT protected', () => {
    expect(isProtectedFinding(['review-finding', 'correctness', 'P2'])).toBe(false);
    expect(isProtectedFinding(['review-finding', 'performance', 'P3'])).toBe(false);
  });
});

describe('isRoutineFinding (⊆ routine vocabulary)', () => {
  it('a label set fully within the routine vocabulary is routine', () => {
    expect(isRoutineFinding(['review-finding', 'correctness', 'P2'])).toBe(true);
    expect(isRoutineFinding(['review-finding', 'performance', 'P0', 'needs-discussion'])).toBe(true);
  });

  it('ANY unrecognized label makes it novel (not routine)', () => {
    expect(isRoutineFinding(['review-finding', 'correctness', 'P2', 'foo'])).toBe(false);
    expect(isRoutineFinding(['review-finding', 'correctness', 'P2', 'compliance'])).toBe(false);
  });
});
