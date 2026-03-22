// park.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createParkState,
  isParkExpired,
  createGateHistory,
  recordGateEvent,
  isGateIterationExceeded,
  lastGateTimestamp,
  type GateEvent,
} from './park.js';

describe('createParkState', () => {
  it('creates a ParkState with correct fields', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const park = createParkState('l2-gate', '.specify/architecture/spec.md', 'l2-approved', 'l2-in-progress');
    expect(park.parkedAt).toBe(now);
    expect(park.gatePhase).toBe('l2-gate');
    expect(park.deliverable).toBe('.specify/architecture/spec.md');
    expect(park.approvalLabel).toBe('l2-approved');
    expect(park.feedbackLabel).toBe('l2-in-progress');
    vi.useRealTimers();
  });
});

describe('isParkExpired', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns false when within timeout', () => {
    const park = createParkState('l2-gate', 'x', 'a', 'b');
    vi.advanceTimersByTime(1000);
    expect(isParkExpired(park)).toBe(false);
  });

  it('returns true after default 7-day timeout', () => {
    const park = createParkState('l2-gate', 'x', 'a', 'b');
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);
    expect(isParkExpired(park)).toBe(true);
  });

  it('respects custom timeout', () => {
    const park = createParkState('l2-gate', 'x', 'a', 'b');
    vi.advanceTimersByTime(5001);
    expect(isParkExpired(park, 5000)).toBe(true);
  });
});

describe('gate history', () => {
  const feedbackEvent: GateEvent = {
    gatePhase: 'l2-gate',
    timestamp: '2026-03-22T10:00:00Z',
    outcome: 'feedback',
    feedbackSummary: 'Revise section 3',
  };

  const approvedEvent: GateEvent = {
    gatePhase: 'l2-gate',
    timestamp: '2026-03-22T11:00:00Z',
    outcome: 'approved',
  };

  it('createGateHistory returns empty history', () => {
    const h = createGateHistory();
    expect(h.events).toHaveLength(0);
    expect(h.iterationCount).toBe(0);
  });

  it('recordGateEvent appends event and increments on feedback', () => {
    let h = createGateHistory();
    h = recordGateEvent(h, feedbackEvent);
    expect(h.events).toHaveLength(1);
    expect(h.iterationCount).toBe(1);
  });

  it('recordGateEvent does not increment on approved', () => {
    let h = createGateHistory();
    h = recordGateEvent(h, approvedEvent);
    expect(h.events).toHaveLength(1);
    expect(h.iterationCount).toBe(0);
  });

  it('trims history to maxEntries', () => {
    let h = createGateHistory();
    for (let i = 0; i < 8; i++) {
      h = recordGateEvent(h, { ...feedbackEvent, timestamp: `2026-03-22T${10 + i}:00:00Z` }, 3);
    }
    expect(h.events).toHaveLength(3);
    expect(h.iterationCount).toBe(8);
  });

  it('isGateIterationExceeded checks against max', () => {
    let h = createGateHistory();
    for (let i = 0; i < 5; i++) {
      h = recordGateEvent(h, feedbackEvent);
    }
    expect(isGateIterationExceeded(h, 5)).toBe(true);
    expect(isGateIterationExceeded(h, 6)).toBe(false);
  });

  it('lastGateTimestamp returns undefined for empty history', () => {
    expect(lastGateTimestamp(createGateHistory())).toBeUndefined();
  });

  it('lastGateTimestamp returns most recent timestamp', () => {
    let h = createGateHistory();
    h = recordGateEvent(h, feedbackEvent);
    h = recordGateEvent(h, approvedEvent);
    expect(lastGateTimestamp(h)).toBe('2026-03-22T11:00:00Z');
  });
});
