// packages/daemon/src/control-plane/lane-engine/earn-in.ts
import type { EarnInPolicy, EarnInResult, LaneTrackRecord } from './types.js';

/**
 * Pure earn-in predicate. A lane with no declared policy is never eligible. The
 * caller decides what eligibility means (raise a promotion DecisionRequest, or
 * auto-promote under a pre-approved + verifier-gated policy) — this function
 * never widens autonomy itself.
 */
export function evaluateEarnIn(
  record: LaneTrackRecord,
  policy: EarnInPolicy | undefined,
): EarnInResult {
  if (policy === undefined) {
    return { kind: 'not-eligible', reasons: ['lane declares no earn-in policy'] };
  }
  const reasons: string[] = [];
  if (record.cleanMerges < policy.cleanMerges) {
    reasons.push(`cleanMerges ${record.cleanMerges} < required ${policy.cleanMerges}`);
  }
  if (record.bounceFreeDays < policy.bounceFreeDays) {
    reasons.push(`bounceFreeDays ${record.bounceFreeDays} < required ${policy.bounceFreeDays}`);
  }
  return reasons.length === 0
    ? { kind: 'eligible-for-promotion', evidence: record }
    : { kind: 'not-eligible', reasons };
}
