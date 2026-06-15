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

/**
 * The most cautious phase: highest mergePolicy caution, ties broken by the
 * LATEST position in declaredPhases. declaredPhases is ordered least → most
 * cautious by convention (e.g. velocity → hardening → clinical), so a later
 * phase wins a tie — making the degraded-mode choice deterministic and never
 * dependent on JS object key insertion order.
 */
function mostCautiousPhase(
  mergePolicy: Record<string, MergePolicy>,
  declaredPhases: string[],
): string {
  const phases = Object.keys(mergePolicy);
  return phases.reduce((best, phase) => {
    const caution = POLICY_CAUTION[mergePolicy[phase]!];
    const bestCaution = POLICY_CAUTION[mergePolicy[best]!];
    if (caution > bestCaution) return phase;
    if (caution === bestCaution && declaredPhases.indexOf(phase) > declaredPhases.indexOf(best)) {
      return phase;
    }
    return best;
  }, phases[0]!);
}

function resolveLane(
  lane: LaneDefinition,
  mode: string | null,
  declaredPhases: string[],
): ResolvedLane {
  const variant = isModeMap(lane.mergePolicy) || isModeMap(lane.gateSet);
  if (!variant) {
    return { ...lane, gateSet: lane.gateSet as string, mergePolicy: lane.mergePolicy as MergePolicy };
  }
  // Schema guarantees both are maps over identical phases when variant.
  const mpMap = lane.mergePolicy as Record<string, MergePolicy>;
  const gsMap = lane.gateSet as Record<string, string>;
  const phase = mode !== null && mode in mpMap ? mode : mostCautiousPhase(mpMap, declaredPhases);
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
    lanes: laneSet.lanes.map((lane) => resolveLane(lane, known ? mode : null, laneSet.declaredPhases)),
    mostCautiousLane: laneSet.mostCautiousLane,
    resolution: { mode: known ? mode : null, degraded, cause },
  };
}
