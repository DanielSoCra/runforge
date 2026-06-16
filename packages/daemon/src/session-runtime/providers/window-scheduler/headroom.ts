// packages/daemon/src/session-runtime/providers/window-scheduler/headroom.ts
import type { Headroom } from './types.js';

/**
 * Headroom ordered least → most capacity (index = preference rank). Mirrors the
 * lane-engine RISK_ORDER idiom so "prefer the larger headroom" is a numeric
 * comparison, not a merge. exhausted(0) < unknown(1) < tight(2) < ample(3).
 */
export const HEADROOM_ORDER: readonly Headroom[] = ['exhausted', 'unknown', 'tight', 'ample'];

/**
 * The fraction of capacity at/above which an evidence-backed pool is `tight`
 * rather than `ample`. The implementer picks the value; tests assert ordering
 * RELATIVE to this constant, never a hardcoded number.
 */
export const TIGHT_FRACTION: number = 0.8;

/** The caution rank of a headroom state (0 = most cautious). */
export function headroomOrder(h: Headroom): number {
  return HEADROOM_ORDER.indexOf(h);
}

/**
 * Estimate-only headroom for a (possibly silent) pool.
 *  - estimate ≥ capacity → exhausted.
 *  - hasEvidence === false → NEVER ample (caps at tight) even at low utilization.
 *  - with evidence: utilization < TIGHT_FRACTION → ample; at/above → tight.
 * Pure: no clock, no I/O.
 */
export function headroomFromEstimate(
  estimate: number,
  capacity: number,
  hasEvidence: boolean,
): Headroom {
  if (estimate >= capacity) {
    return 'exhausted';
  }
  if (!hasEvidence) {
    return 'tight';
  }
  return estimate / capacity < TIGHT_FRACTION ? 'ample' : 'tight';
}
