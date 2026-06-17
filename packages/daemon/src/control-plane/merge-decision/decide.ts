// packages/daemon/src/control-plane/merge-decision/decide.ts
//
// FUNC-AC-MERGE-DECISION Plan 2, slice 5a — the PURE decision core. STUB only:
// the acceptance contract (decide.test.ts) is immovable and the body is filled
// by the external implementer. No I/O, no Date.now(), no mutation of inputs.
//
// Required composition order (the implementer must follow it verbatim):
//   resolveForMode(laneSet, mode)
//     → assignLane(resolvedSet, verdict)
//     → resolve the ResolvedLane by the assigned name
//     → evaluateVerifierGate(lane.verifier, verifierStatus)   // composes FIRST
//     → evaluateMergeEligibility({ lane, classifierLevel, riskPathMap,
//         defaultMinLevel, touchedPaths, modeResolution })
//     → apply the 9-rule, first-match-wins, fail-safe precedence:
//        1. verifier gate ≠ 'verifier-gated'      → escalate 'verifier-withheld'
//        2. complianceForced                       → escalate 'compliance-forced'
//        3. tripwire out-of-scope                  → escalate 'out-of-scope'
//        4. assignment 'fallback-most-cautious'    → escalate 'lane-fallback-most-cautious'
//        5. effectiveRisk orange/red OR capped     → escalate 'risk-ineligible'
//           mergePolicy 'hold' (red never earnable)
//        6. !autonomyWidened(effectiveRisk)        → escalate 'autonomy-not-widened'
//        7. eligible + widened + 'review-then-auto'→ hold 'awaiting-independent-review'
//        8. eligible + widened + 'auto'            → auto-merge
//        9. fall-through                           → escalate 'autonomy-not-widened'

import { assignLane, evaluateMergeEligibility, resolveForMode } from '../lane-engine/index.js';
import { evaluateVerifierGate } from '../lane-engine/verifier-gate/evaluate.js';
import type { ResolvedLane, RiskLevel } from '../lane-engine/types.js';
import type { MergeDecision, MergeDecisionInput } from './types.js';

export function decideMerge(input: MergeDecisionInput): MergeDecision {
  // 1. Resolve the lane set for the current lifecycle mode.
  const resolvedSet = resolveForMode(input.laneSet, input.mode);

  // 2. Assign the change to a lane based on the classifier verdict.
  const assignment = assignLane(resolvedSet, input.verdict);

  // 3. Resolve the assigned lane by name; a fallback-most-cautious assignment
  //    resolves to the deployment's most cautious lane.
  const lane: ResolvedLane =
    resolvedSet.lanes.find((l) => l.name === assignment.lane) ??
    resolvedSet.lanes.find((l) => l.name === resolvedSet.mostCautiousLane)!;

  // 4. Evaluate the verifier gate first (fail-closed).
  const verifierGate = evaluateVerifierGate(lane.verifier, input.verifierStatus);

  // 5. Evaluate merge eligibility (risk-path floor, tripwire, capped policy).
  const eligibility = evaluateMergeEligibility({
    lane,
    classifierLevel: input.classifierLevel,
    riskPathMap: input.riskPathMap,
    defaultMinLevel: input.defaultMinLevel,
    touchedPaths: input.touchedPaths,
    modeResolution: resolvedSet.resolution,
  });

  const effectiveRisk: RiskLevel =
    eligibility.kind === 'eligible' ? eligibility.effectiveRisk : eligibility.effectiveRisk;

  const base = {
    lane,
    effectiveRisk,
    assignment,
    verifierGate,
    modeResolution: resolvedSet.resolution,
  };

  // 9-rule, first-match-wins, fail-safe precedence.

  // 1. verifier gate !== verifier-gated → escalate verifier-withheld.
  if (verifierGate.kind !== 'verifier-gated') {
    return { kind: 'escalate', reason: 'verifier-withheld', ...base };
  }

  // 2. complianceForced === true → escalate compliance-forced.
  if (input.complianceForced === true) {
    return { kind: 'escalate', reason: 'compliance-forced', ...base };
  }

  // 3. tripwire out-of-scope → escalate out-of-scope.
  if (eligibility.kind === 'escalate' && eligibility.reason === 'out-of-scope') {
    return { kind: 'escalate', reason: 'out-of-scope', ...base, eligibility };
  }

  // 4. fallback-most-cautious assignment → escalate lane-fallback-most-cautious.
  if (assignment.kind === 'fallback-most-cautious') {
    return { kind: 'escalate', reason: 'lane-fallback-most-cautious', ...base };
  }

  // 5. effectiveRisk orange/red OR capped mergePolicy hold → escalate risk-ineligible.
  if (
    eligibility.kind === 'eligible' &&
    (effectiveRisk === 'orange' || effectiveRisk === 'red' || eligibility.mergePolicy === 'hold')
  ) {
    return { kind: 'escalate', reason: 'risk-ineligible', ...base, eligibility };
  }

  // 6. autonomyWidened(effectiveRisk) !== true → escalate autonomy-not-widened.
  if (input.autonomyWidened(effectiveRisk) !== true) {
    return { kind: 'escalate', reason: 'autonomy-not-widened', ...base, eligibility };
  }

  // From here on, eligibility must be 'eligible' and autonomy is widened.
  if (eligibility.kind !== 'eligible') {
    // Structural fall-through for any unexpected shape.
    return { kind: 'escalate', reason: 'autonomy-not-widened', ...base, eligibility };
  }

  // 7. eligible + widened + review-then-auto → hold awaiting-independent-review.
  if (eligibility.mergePolicy === 'review-then-auto') {
    return {
      kind: 'hold',
      reason: 'awaiting-independent-review',
      lane,
      effectiveRisk,
      mergePolicy: 'review-then-auto',
      assignment,
      eligibility,
      verifierGate,
      modeResolution: resolvedSet.resolution,
    };
  }

  // 8. eligible + widened + auto → auto-merge.
  if (eligibility.mergePolicy === 'auto') {
    return {
      kind: 'auto-merge',
      lane,
      effectiveRisk,
      mergePolicy: 'auto',
      assignment,
      eligibility,
      verifierGate,
      modeResolution: resolvedSet.resolution,
    };
  }

  // 9. anything else → escalate autonomy-not-widened (structural default-deny).
  return { kind: 'escalate', reason: 'autonomy-not-widened', ...base, eligibility };
}
