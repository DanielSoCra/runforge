// packages/daemon/src/control-plane/lane-engine/resolve-mode.ts
import type {
  LaneDefinition,
  LaneSet,
  MergePolicy,
  ResolvedLane,
  ResolvedLaneSet,
} from './types.js';

const POLICY_CAUTION: Record<MergePolicy, number> = { auto: 0, 'review-then-auto': 1, hold: 2 };

function isModeMap<T>(field: T | Record<string, T>): field is Record<string, T> {
  return typeof field === 'object' && field !== null;
}

/** The phase key whose mergePolicy is most cautious (ties: first declared). */
function mostCautiousPhase(mergePolicy: Record<string, MergePolicy>): string {
  return Object.entries(mergePolicy).reduce((acc, [phase, policy]) =>
    POLICY_CAUTION[policy] > POLICY_CAUTION[mergePolicy[acc]!] ? phase : acc,
  Object.keys(mergePolicy)[0]!);
}

function resolveLane(lane: LaneDefinition, mode: string | null): ResolvedLane {
  const variant = isModeMap(lane.mergePolicy) || isModeMap(lane.gateSet);
  if (!variant) {
    return { ...lane, gateSet: lane.gateSet as string, mergePolicy: lane.mergePolicy as MergePolicy };
  }
  // Schema guarantees both are maps over identical phases when variant.
  const mpMap = lane.mergePolicy as Record<string, MergePolicy>;
  const gsMap = lane.gateSet as Record<string, string>;
  const phase = mode !== null && mode in mpMap ? mode : mostCautiousPhase(mpMap);
  return { ...lane, gateSet: gsMap[phase]!, mergePolicy: mpMap[phase]! };
}

/**
 * Flatten a LaneSet for a deployment's current lifecycle mode into a
 * ResolvedLaneSet the evaluation functions consume. An unreadable (null) or
 * undeclared mode degrades each variant lane to its most cautious phase, with
 * the cause recorded. The evaluation path never sees the mode after this.
 */
export function resolveForMode(laneSet: LaneSet, mode: string | null): ResolvedLaneSet {
  const known = mode !== null && laneSet.declaredPhases.includes(mode);
  const degraded = !known;
  let cause: string | undefined;
  if (mode === null) cause = 'mode-unreadable';
  else if (!known) cause = `mode-undeclared:${mode}`;

  return {
    lanes: laneSet.lanes.map((lane) => resolveLane(lane, known ? mode : null)),
    mostCautiousLane: laneSet.mostCautiousLane,
    resolution: { mode: known ? mode : null, degraded, cause },
  };
}
