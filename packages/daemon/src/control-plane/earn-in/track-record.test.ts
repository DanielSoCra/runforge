import { describe, it, expect } from 'vitest';
import { derivePromotionTrackRecord } from './track-record.js';
import { evaluatePromotion } from './promotion-policy.js';
import type { LaneOutcome } from './types.js';
import type { WideningRecord } from '../deployment-registry/types.js';

const FLOORS = { minCleanMerges: 10, recencyWindowDays: 30, redWindowDays: 30 };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 3);
const isoDaysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

function cleanMerge(daysAgo: number): LaneOutcome {
  return { ts: isoDaysAgo(daysAgo), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' };
}

function red(daysAgo: number): LaneOutcome {
  return { ts: isoDaysAgo(daysAgo), deploymentId: 'dep-a', lane: 'fast', kind: 'red', redReason: 'failed-release' };
}

function bounce(daysAgo: number): LaneOutcome {
  return { ts: isoDaysAgo(daysAgo), deploymentId: 'dep-a', lane: 'fast', kind: 'bounce', bounceReason: 'scope-tripwire' };
}

function demoteRecord(daysAgo: number): WideningRecord {
  return {
    deploymentId: 'dep-a',
    riskClass: 'green',
    prior: 'widened',
    next: 'human-gated',
    authorization: { kind: 'demote-on-red', trigger: 'red-trunk' },
    recordedAt: NOW - daysAgo * DAY,
  };
}

describe('derivePromotionTrackRecord', () => {
  it('counts ten clean merges in window with no red', () => {
    const outcomes = Array.from({ length: 10 }, (_v, i) => cleanMerge(i * 2));
    const record = derivePromotionTrackRecord(outcomes, [], NOW, FLOORS);
    expect(record.bar.cleanMerges).toBe(10);
    expect(record.cleanMergesInWindow).toBe(10);
    expect(record.redEventInWindow).toBe(false);
  });

  it('treats a dormant lane as having only the in-window count', () => {
    const outcomes = [...Array.from({ length: 10 }, () => cleanMerge(100)), cleanMerge(1)];
    const record = derivePromotionTrackRecord(outcomes, [], NOW, FLOORS);
    expect(record.bar.cleanMerges).toBe(11);
    expect(record.cleanMergesInWindow).toBe(1);
  });

  it('sets redEventInWindow from a recent red outcome', () => {
    const record = derivePromotionTrackRecord([red(5)], [], NOW, FLOORS);
    expect(record.redEventInWindow).toBe(true);
  });

  it('ignores a red outcome outside the window', () => {
    const record = derivePromotionTrackRecord([red(40)], [], NOW, FLOORS);
    expect(record.redEventInWindow).toBe(false);
  });

  it('sets redEventInWindow from a recent demote record', () => {
    const record = derivePromotionTrackRecord([], [demoteRecord(5)], NOW, FLOORS);
    expect(record.redEventInWindow).toBe(true);
  });

  it('resets bounce-free days from the most recent bounce', () => {
    const outcomes = [cleanMerge(100), bounce(3), cleanMerge(1)];
    const record = derivePromotionTrackRecord(outcomes, [], NOW, FLOORS);
    expect(record.bar.bounceFreeDays).toBe(3);
  });

  it('derives bounce-free days from the EARLIEST outcome when no bounce exists (not a full-window grant)', () => {
    // A long-lived clean lane earns its actual streak: earliest outcome 100d ago.
    const outcomes = [cleanMerge(100), cleanMerge(50)];
    const record = derivePromotionTrackRecord(outcomes, [], NOW, FLOORS);
    expect(record.bar.bounceFreeDays).toBe(100); // actual elapsed, NOT the 30d window
  });

  it('a too-young clean lane reads ~1 bounce-free day, NOT the full window (codex P4.2 P1)', () => {
    // Ten clean merges all within the last day, no bounces. The earliest outcome
    // is 1 day ago, so the bounce-free streak is 1 — NOT a hardcoded 30. Without
    // the fix this read 30, cleared the recency floor, and auto-widened after ~1d.
    const outcomes = [
      cleanMerge(1),
      ...Array.from({ length: 9 }, (_v, i) => cleanMerge((i + 1) / 20)),
    ];
    const record = derivePromotionTrackRecord(outcomes, [], NOW, FLOORS);
    expect(record.bar.bounceFreeDays).toBe(1);
    expect(record.bar.bounceFreeDays).not.toBe(FLOORS.recencyWindowDays);
    expect(record.bar.cleanMerges).toBe(10);
    expect(record.cleanMergesInWindow).toBe(10);

    // With the derived bar carried as the declared bar, the recency floor now
    // fires → raise-decision (escalate), NEVER auto-widen. Pre-fix (bounceFreeDays
    // 30) this same input cleared every floor and auto-widened.
    const res = evaluatePromotion({
      record,
      bar: record.bar,
      preApproved: { enabled: true, policyRef: 'ops-pack-v1' },
      verifierFalsifying: true,
      scopeHolding: true,
    });
    expect(res.kind).toBe('raise-decision');
    if (res.kind === 'raise-decision') {
      expect(res.failedFloors).toContain('bar-recency-below-floor');
    }
  });

  it('returns zero bounce-free days when there are no outcomes', () => {
    const record = derivePromotionTrackRecord([], [], NOW, FLOORS);
    expect(record.bar.bounceFreeDays).toBe(0);
    expect(record.bar.cleanMerges).toBe(0);
  });
});
