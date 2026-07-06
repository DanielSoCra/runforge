// packages/daemon/src/control-plane/earn-in/types.ts
// Shared types for the pre-approved earn-in promotion mechanism (STACK-AC-EARN-IN).

import type { LaneTrackRecord, RiskLevel } from '../lane-engine/types.js';

/**
 * The non-configurable platform floors that guard auto-widening. Values are
 * provisional pending the Operator's ruling (bridge #104); the mechanism itself
 * is stable.
 */
export interface EarnInFloors {
  minCleanMerges: number;
  recencyWindowDays: number;
  redWindowDays: number;
}

/** Named floor failures / cleared floors used in audit evidence. */
export type FloorName =
  | 'bar-clean-merges-below-floor'
  | 'bar-recency-below-floor'
  | 'insufficient-recent-clean-merges'
  | 'red-in-window'
  | 'scope-not-holding'
  | 'verifier-not-gated'
  | 'reversible';

/** The floor-relevant track record derived from recorded outcomes + autonomy history. */
export interface PromotionTrackRecord {
  /** The lane-engine bar predicate input (cumulative clean merges + bounce-free days). */
  bar: LaneTrackRecord;
  /** Full count of clean merges within the recency window — NOT merely most-recent. */
  cleanMergesInWindow: number;
  /** True if any red event or demote-on-red record falls within the red window. */
  redEventInWindow: boolean;
}

/** Input to `evaluatePromotion`. */
export interface PromotionInput {
  record: PromotionTrackRecord;
  bar: { cleanMerges: number; bounceFreeDays: number } | undefined;
  preApproved?: { enabled: boolean; policyRef: string };
  verifierFalsifying: boolean;
  scopeHolding: boolean;
}

/** Result of evaluating the earn-in floors over a lane's bar. */
export type PromotionResult =
  | { kind: 'not-eligible' }
  | { kind: 'raise-decision'; failedFloors: FloorName[] }
  | {
      kind: 'auto-widen';
      clearedFloors: FloorName[];
      evidence: PromotionTrackRecord;
      policyRef: string;
    };

/** Input to `planMint`. */
export interface MintInput {
  promotion: PromotionResult;
  effectiveRisk: RiskLevel;
  verifierFalsifying: boolean;
  complianceForced: boolean;
  currentlyHumanGated: boolean;
  isDebut: boolean;
  hasDebutAuthorization: boolean;
}

/** The snapshot of triggering evidence recorded with an earn-in widening. */
export interface EarnInWideningEvidence {
  cleanMerges: number;
  cleanMergesInWindow: number;
  bounceFreeDays: number;
  redEventInWindow: boolean;
}

/** Result of planning a mint. */
export type MintPlan =
  | { kind: 'mint'; level: RiskLevel; policyRef: string; clearedFloors: string[]; evidence: EarnInWideningEvidence }
  | { kind: 'withhold-debut' }
  | { kind: 'skip' };

/** Classified red-event kinds that set the red-window marker and may trigger demotion. */
export type RedEventKind =
  | 'red-risk-merge'
  | 'batch-review-high-severity'
  | 'post-merge-tripwire'
  | 'failed-release'
  | 'compliance-breach';

/** Reasons a change bounced (did not merge cleanly / was rejected). */
export type BounceReason = 'scope-tripwire' | 'failed-check' | 'review-block' | 'operator-send-back';

/** One recorded outcome for a (deployment, lane) pair. */
export interface LaneOutcome {
  ts: string;
  deploymentId: string;
  lane: string;
  kind: 'clean-merge' | 'bounce' | 'red';
  bounceReason?: BounceReason;
  redReason?: RedEventKind;
  riskClass?: RiskLevel;
  issueNumber?: number;
}
