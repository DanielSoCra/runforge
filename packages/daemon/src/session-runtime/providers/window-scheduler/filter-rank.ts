// packages/daemon/src/session-runtime/providers/window-scheduler/filter-rank.ts
import type { Candidate, FilterRankResult, LedgerSnapshot } from './types.js';

import { headroomOrder } from './headroom.js';

/**
 * The pure window stage, composed AFTER the registry's tier+health filter and
 * BEFORE its short-circuit return. It can only REMOVE and REORDER — never admit a
 * candidate the registry rejected, never introduce one absent from `candidates`.
 *
 *  - Drops every candidate whose pool snapshot is `exhausted`; names those pools
 *    in `excludePools` (a pool exhaustion drops ALL its providers at once).
 *  - Within the same preferenceRank, sorts by headroom (larger headroom first), so
 *    `tight` sinks below `ample`; ordering is stable.
 *  - `unknown` is dispatchable (NOT dropped) but never preferred over tight/ample
 *    (ranks WITH tight for eligibility, BELOW it for preference).
 *  - Empty `eligible` (all pools exhausted) → caller raises provider-unavailable.
 *
 * Pure: reads only `candidates` and the immutable `snap`; no clock, no I/O.
 */
export function filterAndRankByWindow(
  candidates: readonly Candidate[],
  snap: LedgerSnapshot,
): FilterRankResult {
  const live = candidates.filter((c) => snap.headroom(c.pool) !== 'exhausted');
  const ranked = [...live].sort((a, b) => {
    const rankDiff = a.preferenceRank - b.preferenceRank;
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return headroomOrder(snap.headroom(b.pool)) - headroomOrder(snap.headroom(a.pool));
  });
  const excludePools = [
    ...new Set(candidates.filter((c) => snap.headroom(c.pool) === 'exhausted').map((c) => c.pool)),
  ];
  return { eligible: ranked, excludePools };
}
