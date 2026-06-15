// packages/daemon/src/control-plane/lane-engine/eligibility.ts
import type { Eligibility, EligibilityInput, MergePolicy, RiskLevel } from './types.js';
import { applyRiskPathFloor } from './risk.js';
import { evaluateTripwire } from './tripwire.js';

const POLICY_CAUTION: Record<MergePolicy, number> = { auto: 0, 'review-then-auto': 1, hold: 2 };

/** The most permissive policy each risk level may earn (the caution ceiling). */
const RISK_MAX_POLICY: Record<RiskLevel, MergePolicy> = {
  green: 'auto',
  yellow: 'review-then-auto',
  orange: 'hold',
  red: 'hold',
};

/**
 * A lane's mergePolicy is a request, not a grant. Cap it by the effective risk
 * level: return the MORE cautious of the lane's policy and the risk ceiling.
 */
export function capPolicy(lanePolicy: MergePolicy, risk: RiskLevel): MergePolicy {
  const ceiling = RISK_MAX_POLICY[risk];
  return POLICY_CAUTION[lanePolicy] >= POLICY_CAUTION[ceiling] ? lanePolicy : ceiling;
}

/**
 * The fixed, non-configurable evaluation order at the integration boundary:
 * risk-path floor (raise-only) → tripwire → gate-set + capped merge policy.
 * Compliance and earned-autonomy compose OVER this result in the merge-decision
 * caller (Plan 2) — never inside here.
 */
export function evaluateMergeEligibility(input: EligibilityInput): Eligibility {
  const effectiveRisk = applyRiskPathFloor(input.classifierLevel, input.riskPathMap, input.touchedPaths);
  const tripwire = evaluateTripwire(input.touchedPaths, input.lane);
  if (tripwire.kind !== 'in-scope') {
    return { kind: 'escalate', effectiveRisk, reason: 'out-of-scope', tripwire };
  }
  return {
    kind: 'eligible',
    effectiveRisk,
    gateSet: input.lane.gateSet,
    mergePolicy: capPolicy(input.lane.mergePolicy, effectiveRisk),
    tripwire,
  };
}
