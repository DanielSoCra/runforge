// src/knowledge/policy-registry.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POLICIES,
  buildPolicies,
  type LifecyclePolicy,
} from './policy-registry.js';

describe('DEFAULT_POLICIES', () => {
  it('defines a policy for each record type', () => {
    expect(DEFAULT_POLICIES.technical_pitfall).toBeDefined();
    expect(DEFAULT_POLICIES.business_observation).toBeDefined();
    expect(DEFAULT_POLICIES.operator_correction).toBeDefined();
    expect(DEFAULT_POLICIES.review_finding).toBeDefined();
  });

  it('technical_pitfall targets implementation and review sessions', () => {
    const p = DEFAULT_POLICIES.technical_pitfall;
    expect(p.injectionTargets).toContain('implementation');
    expect(p.injectionTargets).toContain('review');
    expect(p.promotionThreshold).toBe(5);
  });

  it('business_observation targets product_ownership sessions with lower threshold', () => {
    const p = DEFAULT_POLICIES.business_observation;
    expect(p.injectionTargets).toContain('product_ownership');
    expect(p.promotionThreshold).toBe(3);
  });

  it('operator_correction has no archival (Infinity max age) and threshold 2', () => {
    const p = DEFAULT_POLICIES.operator_correction;
    expect(p.promotionThreshold).toBe(2);
    expect(p.archivalMaxAgeDays).toBe(Infinity);
    expect(p.injectionTargets).toContain('implementation');
    expect(p.injectionTargets).toContain('review');
  });

  it('review_finding targets technical_leadership sessions', () => {
    const p = DEFAULT_POLICIES.review_finding;
    expect(p.injectionTargets).toContain('technical_leadership');
    expect(p.promotionThreshold).toBe(5);
  });
});

describe('buildPolicies', () => {
  it('returns defaults when no overrides provided', () => {
    const policies = buildPolicies();
    expect(policies).toEqual(DEFAULT_POLICIES);
  });

  it('merges overrides for a specific record type', () => {
    const policies = buildPolicies({
      technical_pitfall: { promotionThreshold: 10 },
    });
    expect(policies.technical_pitfall.promotionThreshold).toBe(10);
    // Other fields unchanged
    expect(policies.technical_pitfall.injectionTargets).toEqual(
      DEFAULT_POLICIES.technical_pitfall.injectionTargets,
    );
    // Other types unchanged
    expect(policies.business_observation).toEqual(DEFAULT_POLICIES.business_observation);
  });

  it('merges overrides for multiple record types', () => {
    const policies = buildPolicies({
      business_observation: { promotionThreshold: 5 },
      operator_correction: { promotionThreshold: 3 },
    });
    expect(policies.business_observation.promotionThreshold).toBe(5);
    expect(policies.operator_correction.promotionThreshold).toBe(3);
  });
});
