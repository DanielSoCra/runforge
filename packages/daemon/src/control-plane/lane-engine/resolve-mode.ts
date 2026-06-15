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

// gateSet and mergePolicy are declared per-mode INDEPENDENTLY (the L2/L3
// byMode contract) — a lane may vary one, both, or neither. Each is resolved
// on its own; there is no cross-field coherence requirement.

/**
 * mergePolicy degraded resolution: the most cautious value by caution rank,
 * ties broken by the LATEST declared phase (declaredPhases is ordered least →
 * most cautious by convention, e.g. velocity → hardening → clinical). The spec
 * fixes the mergePolicy caution order (hold > review-then-auto > auto), so it
 * drives the choice; declared-phase order is only the deterministic tie-break.
 */
function mostCautiousMergePolicy(
  map: Record<string, MergePolicy>,
  declaredPhases: string[],
): MergePolicy {
  const best = Object.keys(map).reduce((acc, phase) => {
    const caution = POLICY_CAUTION[map[phase]!];
    const accCaution = POLICY_CAUTION[map[acc]!];
    if (caution > accCaution) return phase;
    if (caution === accCaution && declaredPhases.indexOf(phase) > declaredPhases.indexOf(acc)) {
      return phase;
    }
    return acc;
  }, Object.keys(map)[0]!);
  return map[best]!;
}

function resolveGateSet(
  gateSet: LaneDefinition['gateSet'],
  mode: string | null,
  declaredPhases: string[],
): string {
  if (!isModeMap(gateSet)) return gateSet;
  if (mode !== null && mode in gateSet) return gateSet[mode]!;
  // Degraded: gate-set names carry no intrinsic caution order, so pick the
  // LATEST declared phase present (most cautious by the declaredPhases convention).
  const present = declaredPhases.filter((phase) => phase in gateSet);
  const phase = present.length > 0 ? present[present.length - 1]! : Object.keys(gateSet)[0]!;
  return gateSet[phase]!;
}

function resolveMergePolicy(
  mergePolicy: LaneDefinition['mergePolicy'],
  mode: string | null,
  declaredPhases: string[],
): MergePolicy {
  if (!isModeMap(mergePolicy)) return mergePolicy;
  if (mode !== null && mode in mergePolicy) return mergePolicy[mode]!;
  return mostCautiousMergePolicy(mergePolicy, declaredPhases);
}

function resolveLane(
  lane: LaneDefinition,
  mode: string | null,
  declaredPhases: string[],
): ResolvedLane {
  return {
    ...lane,
    gateSet: resolveGateSet(lane.gateSet, mode, declaredPhases),
    mergePolicy: resolveMergePolicy(lane.mergePolicy, mode, declaredPhases),
  };
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
