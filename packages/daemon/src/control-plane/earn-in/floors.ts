// packages/daemon/src/control-plane/earn-in/floors.ts
// Frozen earn-in floors + autonomous-eligibility predicate (STACK-AC-EARN-IN).

import type { RiskLevel } from '../lane-engine/types.js';
import type { EarnInFloors, FloorName } from './types.js';

// PROVISIONAL — Operator ruling pending (bridge #104); values, never the mechanism, change.
export const EARN_IN_FLOORS: Readonly<EarnInFloors> = Object.freeze({
  minCleanMerges: 10,
  recencyWindowDays: 30,
  redWindowDays: 30,
});

export const FLOOR_NAMES: readonly FloorName[] = Object.freeze([
  'bar-clean-merges-below-floor',
  'bar-recency-below-floor',
  'insufficient-recent-clean-merges',
  'red-in-window',
  'scope-not-holding',
  'verifier-not-gated',
  'reversible',
]);

/** True iff the risk level is eligible for an autonomous proceed (green/yellow). */
export function isAutonomousEligible(level: RiskLevel): boolean {
  return level === 'green' || level === 'yellow';
}
