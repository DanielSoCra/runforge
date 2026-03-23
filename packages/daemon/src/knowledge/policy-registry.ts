// src/knowledge/policy-registry.ts
import type { RecordType } from './record-types.js';

export interface LifecyclePolicy {
  promotionThreshold: number;
  promotionMaxAgeDays: number;
  archivalMaxAgeDays: number;
  archivalMinHitCount: number;
  injectionTargets: string[];
  sortOrder: 'priority_then_hits' | 'recency' | 'severity_then_recency';
}

export type PolicyRegistry = Record<RecordType, LifecyclePolicy>;

export const DEFAULT_POLICIES: PolicyRegistry = {
  technical_pitfall: {
    promotionThreshold: 5,
    promotionMaxAgeDays: 90,
    archivalMaxAgeDays: 90,
    archivalMinHitCount: 2,
    injectionTargets: ['implementation', 'review'],
    sortOrder: 'priority_then_hits',
  },
  business_observation: {
    promotionThreshold: 3,
    promotionMaxAgeDays: 90,
    archivalMaxAgeDays: 90,
    archivalMinHitCount: 2,
    injectionTargets: ['product_ownership'],
    sortOrder: 'recency',
  },
  operator_correction: {
    promotionThreshold: 2,
    promotionMaxAgeDays: 90,
    archivalMaxAgeDays: Infinity,
    archivalMinHitCount: 0,
    injectionTargets: ['implementation', 'review'],
    sortOrder: 'priority_then_hits',
  },
  review_finding: {
    promotionThreshold: 5,
    promotionMaxAgeDays: 90,
    archivalMaxAgeDays: 90,
    archivalMinHitCount: 2,
    injectionTargets: ['technical_leadership'],
    sortOrder: 'severity_then_recency',
  },
};

export function buildPolicies(
  overrides?: Partial<Record<RecordType, Partial<LifecyclePolicy>>>,
): PolicyRegistry {
  if (!overrides) return { ...DEFAULT_POLICIES };
  const result = { ...DEFAULT_POLICIES };
  for (const [type, partial] of Object.entries(overrides)) {
    const key = type as RecordType;
    if (result[key] && partial) {
      result[key] = { ...result[key], ...partial };
    }
  }
  return result;
}
