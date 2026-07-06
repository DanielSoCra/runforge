// packages/daemon/src/control-plane/earn-in/track-record.ts
// Derive the floor-relevant PromotionTrackRecord from recorded outcomes + history.

import type { EarnInFloors, LaneOutcome, PromotionTrackRecord } from './types.js';
import type { WideningRecord } from '../deployment-registry/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTs(ts: string): number {
  return new Date(ts).getTime();
}

function wholeDaysBetween(later: number, earlier: number): number {
  return Math.floor((later - earlier) / DAY_MS);
}

/**
 * Derive the PromotionTrackRecord for a (deployment, lane) from its raw outcome
 * stream and the deployment's autonomy history. Pure: `now` is passed in.
 */
export function derivePromotionTrackRecord(
  outcomes: LaneOutcome[],
  autonomyHistory: WideningRecord[],
  now: number,
  floors: EarnInFloors,
): PromotionTrackRecord {
  const cleanMerges = outcomes.filter((o) => o.kind === 'clean-merge').length;

  const bounces = outcomes
    .filter((o) => o.kind === 'bounce')
    .map((o) => parseTs(o.ts))
    .sort((a, b) => b - a);
  let bounceFreeDays: number;
  if (bounces.length > 0) {
    bounceFreeDays = wholeDaysBetween(now, bounces[0]!);
  } else if (outcomes.length > 0) {
    // No bounce on record: the bounce-free streak is the ACTUAL elapsed time from
    // the EARLIEST recorded outcome to `now` — not a hardcoded full window. A lane
    // whose earliest outcome is one day ago reads ~1 bounce-free day, so a too-young
    // lane (fresh clean merges, no elapsed history) cannot clear the recency floor
    // after a single day. A genuinely long-lived clean lane earns its full streak.
    const earliestOutcomeTs = Math.min(...outcomes.map((o) => parseTs(o.ts)));
    bounceFreeDays = wholeDaysBetween(now, earliestOutcomeTs);
  } else {
    bounceFreeDays = 0;
  }

  const recencyCutoff = now - floors.recencyWindowDays * DAY_MS;
  const cleanMergesInWindow = outcomes.filter(
    (o) => o.kind === 'clean-merge' && parseTs(o.ts) >= recencyCutoff,
  ).length;

  const redCutoff = now - floors.redWindowDays * DAY_MS;
  const redOutcomeInWindow = outcomes.some(
    (o) => o.kind === 'red' && parseTs(o.ts) >= redCutoff,
  );
  const demoteInWindow = autonomyHistory.some(
    (r) => r.next === 'human-gated' && r.recordedAt >= redCutoff,
  );

  return {
    bar: { cleanMerges, bounceFreeDays },
    cleanMergesInWindow,
    redEventInWindow: redOutcomeInWindow || demoteInWindow,
  };
}
