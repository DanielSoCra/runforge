// packages/daemon/src/control-plane/earn-in/index.ts
// Barrel export for the pre-approved earn-in promotion mechanism (STACK-AC-EARN-IN).

export { derivePromotionTrackRecord } from './track-record.js';
export { evaluatePromotion, floorsFailed } from './promotion-policy.js';
export { isDebut } from './debut.js';
export { planMint } from './mint.js';
export { isRedEvent, triggerDemoteOnRed } from './demote-on-red.js';
export { EARN_IN_FLOORS, FLOOR_NAMES, isAutonomousEligible } from './floors.js';
export type {
  EarnInFloors,
  FloorName,
  PromotionTrackRecord,
  PromotionInput,
  PromotionResult,
  MintInput,
  MintPlan,
  EarnInWideningEvidence,
  RedEventKind,
  BounceReason,
  LaneOutcome,
} from './types.js';
