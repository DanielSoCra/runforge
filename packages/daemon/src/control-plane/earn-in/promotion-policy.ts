// packages/daemon/src/control-plane/earn-in/promotion-policy.ts
// Pure floor evaluator composed over the lane-engine bar predicate.

import { evaluateEarnIn } from '../lane-engine/earn-in.js';
import { EARN_IN_FLOORS, FLOOR_NAMES } from './floors.js';
import type { FloorName, PromotionInput, PromotionResult } from './types.js';

/**
 * Return ALL floor failures for the given input. Includes the declared-bar-below-floor
 * checks so a weak bar surfaces as complete audit evidence, never a silent non-match.
 */
export function floorsFailed(input: PromotionInput): FloorName[] {
  const failed: FloorName[] = [];

  if (input.bar === undefined || input.bar.cleanMerges < EARN_IN_FLOORS.minCleanMerges) {
    failed.push('bar-clean-merges-below-floor');
  }
  if (input.bar === undefined || input.bar.bounceFreeDays < EARN_IN_FLOORS.recencyWindowDays) {
    failed.push('bar-recency-below-floor');
  }
  if (input.record.cleanMergesInWindow < EARN_IN_FLOORS.minCleanMerges) {
    failed.push('insufficient-recent-clean-merges');
  }
  if (input.record.redEventInWindow === true) {
    failed.push('red-in-window');
  }
  if (input.scopeHolding !== true) {
    failed.push('scope-not-holding');
  }
  if (input.verifierFalsifying !== true) {
    failed.push('verifier-not-gated');
  }

  // reversible is satisfied by construction: the mint records through recordWidening.
  return failed;
}

/**
 * Evaluate whether a lane qualifies for an auto-widen under its pre-approved earn-in
 * policy. Composes the existing bar predicate with the non-configurable floors.
 */
export function evaluatePromotion(input: PromotionInput): PromotionResult {
  const barVerdict = evaluateEarnIn(input.record.bar, input.bar);
  if (barVerdict.kind !== 'eligible-for-promotion') {
    return { kind: 'not-eligible' };
  }

  const failed = floorsFailed(input);
  const eligible =
    input.preApproved !== undefined &&
    input.preApproved.enabled === true &&
    failed.length === 0;

  if (eligible) {
    return {
      kind: 'auto-widen',
      clearedFloors: [...FLOOR_NAMES],
      evidence: input.record,
      policyRef: input.preApproved!.policyRef,
    };
  }

  return { kind: 'raise-decision', failedFloors: failed };
}
