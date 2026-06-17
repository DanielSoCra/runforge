// packages/daemon/src/control-plane/merge-decision/types.ts
//
// FUNC-AC-MERGE-DECISION Plan 2, slice 5a — the PURE decision-core contract.
// decideMerge composes the lane engine (resolveForMode → assignLane →
// evaluateMergeEligibility) with the verifier gate and produces ONE fail-safe,
// most-cautious decision. The verifier gate composes AHEAD of everything: an
// absent or withheld verifier escalates before any other arm is considered.

import type {
  ClassifierVerdict,
  Eligibility,
  LaneAssignmentResult,
  LaneSet,
  MergePolicy,
  ModeResolution,
  ResolvedLane,
  RiskLevel,
  RiskPathMap,
} from '../lane-engine/types.js';
import type { VerifierGateResult, VerifierStatus } from '../lane-engine/verifier-gate/types.js';

/**
 * Every input the decision needs. All pure data — no clocks, no I/O. The live
 * wiring (slice 5b) is responsible for producing each field (registry config,
 * a merge-base git diff for `touchedPaths`, a fail-closed verifier observation,
 * and the human-gated autonomy state behind `autonomyWidened`).
 */
export interface MergeDecisionInput {
  /** The deployment's validated lane set (pre mode-resolution). */
  laneSet: LaneSet;
  /** Risk-path floor entries, applied raise-only to the touched paths. */
  riskPathMap: RiskPathMap;
  /** The deployment's configured default minimum risk for unmatched paths. */
  defaultMinLevel: RiskLevel;
  /** The deployment's current lifecycle mode (resolved by resolveForMode). */
  mode: string;
  /** The classifier verdict, or null when unavailable (forces fallback). */
  verdict: ClassifierVerdict | null;
  /** The classifier's own risk level (floor-raised by the risk-path map). */
  classifierLevel: RiskLevel;
  /** What the change ACTUALLY touched (merge-base diff in the live layer). */
  touchedPaths: string[];
  /** The observed verifier status fed to the verifier gate (does a falsifying
   *  verifier EXIST and is it runnable). Distinct from `validationPassed`. */
  verifierStatus: VerifierStatus;
  /**
   * Whether the lane's gate-set verification actually RAN and PASSED for this
   * change. The verifier gate proves a falsifying verifier exists; this proves
   * it passed. FUNC-AC-MERGE-DECISION: "no verification means no autonomous
   * proceed" — auto-merge requires `true`. False/unknown escalates (fail-safe).
   */
  validationPassed: boolean;
  /**
   * Whether autonomy is widened for a given effective risk level AND lane. The
   * human-gated default is `() => false` — the safe-by-default arm. `lane` is
   * the assigned lane's name so a deployment may grant autonomy per risk level
   * OR per lane (FUNC-AC-MERGE-DECISION: "a given risk level or lane"); a
   * per-level grant simply ignores the lane argument. Pure + deterministic.
   */
  autonomyWidened: (level: RiskLevel, lane: string) => boolean;
  /** Whether a compliance review is mandated for this change (escalates). */
  complianceForced: boolean;
}

/**
 * Why a change did not auto-merge. First-match-wins precedence order, most
 * cautious first; `verifier-withheld` covers BOTH a withheld status and a lane
 * with no verifier declared at all.
 */
export type MergeDecisionReason =
  | 'verifier-withheld'
  | 'verification-not-passed'
  | 'compliance-forced'
  | 'out-of-scope'
  | 'lane-fallback-most-cautious'
  | 'risk-ineligible'
  | 'autonomy-not-widened';

/**
 * The single decision. `auto-merge` is the only arm that authorizes the merge;
 * `hold` parks for an independent review that may later release; `escalate`
 * routes to the operator. Audit context (assignment, eligibility, verifierGate,
 * modeResolution) is carried on every arm where it is known.
 */
export type MergeDecision =
  | {
      kind: 'auto-merge';
      lane: ResolvedLane;
      effectiveRisk: RiskLevel;
      mergePolicy: MergePolicy;
      assignment: LaneAssignmentResult;
      eligibility: Eligibility;
      verifierGate: VerifierGateResult;
      modeResolution: ModeResolution;
    }
  | {
      kind: 'escalate';
      reason: MergeDecisionReason;
      lane: ResolvedLane;
      effectiveRisk: RiskLevel;
      assignment: LaneAssignmentResult;
      eligibility?: Eligibility;
      verifierGate: VerifierGateResult;
      modeResolution: ModeResolution;
    }
  | {
      kind: 'hold';
      reason: 'awaiting-independent-review';
      lane: ResolvedLane;
      effectiveRisk: RiskLevel;
      mergePolicy: 'review-then-auto';
      assignment: LaneAssignmentResult;
      eligibility: Eligibility;
      verifierGate: VerifierGateResult;
      modeResolution: ModeResolution;
    };
