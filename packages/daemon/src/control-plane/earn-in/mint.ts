// packages/daemon/src/control-plane/earn-in/mint.ts
// Pure mint planner: turns an auto-widen evaluation into a registry write plan.

import { isAutonomousEligible } from './floors.js';
import type { EarnInWideningEvidence, MintInput, MintPlan, PromotionTrackRecord } from './types.js';

function toEvidence(promotionEvidence: PromotionTrackRecord): EarnInWideningEvidence {
  return {
    cleanMerges: promotionEvidence.bar.cleanMerges,
    cleanMergesInWindow: promotionEvidence.cleanMergesInWindow,
    bounceFreeDays: promotionEvidence.bar.bounceFreeDays,
    redEventInWindow: promotionEvidence.redEventInWindow,
  };
}

/**
 * Plan whether to mint a widening, withhold it for debut authorization, or skip.
 * Pure: all state is passed in; the caller performs I/O.
 */
export function planMint(input: MintInput): MintPlan {
  if (input.promotion.kind !== 'auto-widen') {
    return { kind: 'skip' };
  }

  if (
    !input.verifierFalsifying ||
    input.complianceForced ||
    !isAutonomousEligible(input.effectiveRisk) ||
    !input.currentlyHumanGated
  ) {
    return { kind: 'skip' };
  }

  if (input.isDebut && !input.hasDebutAuthorization) {
    return { kind: 'withhold-debut' };
  }

  return {
    kind: 'mint',
    level: input.effectiveRisk,
    policyRef: input.promotion.policyRef,
    clearedFloors: input.promotion.clearedFloors,
    evidence: toEvidence(input.promotion.evidence),
  };
}
