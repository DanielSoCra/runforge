// packages/daemon/src/control-plane/lane-engine/tripwire.ts
import type { ResolvedLane, TripwireVerdict } from './types.js';
import { matchesAny } from './match.js';

/**
 * Compare what a change ACTUALLY touched against the lane's declared allowed
 * scope. Pure: callers pass the real touched-path set (from a merge-base git
 * diff in the integration layer). The non-configurable safeguard against the
 * platform's own lane-classification errors.
 */
export function evaluateTripwire(
  touched: string[],
  lane: Pick<ResolvedLane, 'allowedPaths'>,
): TripwireVerdict {
  const outside = touched.filter((p) => !matchesAny(p, lane.allowedPaths));
  return outside.length === 0
    ? { kind: 'in-scope', touched }
    : { kind: 'out-of-scope', touched, outside };
}
