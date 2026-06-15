// packages/daemon/src/control-plane/lane-engine/assign.ts
import type {
  ClassifierVerdict,
  LaneAssignmentResult,
  ResolvedLane,
  ResolvedLaneSet,
} from './types.js';

/**
 * A lane qualifies if every declared criterion is satisfied by the verdict. A
 * criterion that is declared but unsatisfiable by the verdict (missing field
 * or value not in the allowed list) fails the lane. A lane with no criteria is
 * a catch-all.
 */
function qualifies(lane: ResolvedLane, verdict: ClassifierVerdict): boolean {
  const { complexity, changeKind } = lane.qualify;
  if (
    complexity !== undefined &&
    (verdict.complexity === undefined || !complexity.includes(verdict.complexity))
  ) {
    return false;
  }
  if (
    changeKind !== undefined &&
    (verdict.changeKind === undefined || !changeKind.includes(verdict.changeKind))
  ) {
    return false;
  }
  return true;
}

function reasonsFor(lane: ResolvedLane, verdict: ClassifierVerdict): string[] {
  const reasons: string[] = [];
  if (lane.qualify.complexity !== undefined && verdict.complexity !== undefined) {
    reasons.push(`complexity=${verdict.complexity}`);
  }
  if (lane.qualify.changeKind !== undefined && verdict.changeKind !== undefined) {
    reasons.push(`changeKind=${verdict.changeKind}`);
  }
  if (reasons.length === 0) reasons.push('catch-all (no qualification criteria)');
  return reasons;
}

/**
 * Assign a change to exactly one lane. Zero matches, 2+ matches, or an
 * unavailable verdict all fail safe to the deployment's most-cautious lane,
 * with the cause recorded. There is no specificity ranking — qualifications
 * are expected to be mutually exclusive (the schema flags overlaps).
 */
export function assignLane(
  laneSet: ResolvedLaneSet,
  verdict: ClassifierVerdict | null,
): LaneAssignmentResult {
  if (verdict === null) {
    return {
      kind: 'fallback-most-cautious',
      lane: laneSet.mostCautiousLane,
      cause: 'verdict-unavailable',
    };
  }
  const matches = laneSet.lanes.filter((lane) => qualifies(lane, verdict));
  if (matches.length === 1) {
    const only = matches[0]!;
    return { kind: 'assigned', lane: only.name, reasons: reasonsFor(only, verdict) };
  }
  return {
    kind: 'fallback-most-cautious',
    lane: laneSet.mostCautiousLane,
    cause: matches.length === 0 ? 'no-match' : 'ambiguous',
  };
}
