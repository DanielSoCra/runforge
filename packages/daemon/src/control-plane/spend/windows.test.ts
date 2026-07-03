/**
 * STACK-AC-SPEND-OBSERVABILITY — period windowing unit tests.
 *
 * Pins: named-period resolution against an INJECTED clock (never Date.now()),
 * custom-range pass-through, and the preceding window being equal-length AND
 * immediately preceding for named and odd-length custom ranges alike.
 */
import { describe, it, expect } from 'vitest';
import { periodWindow, precedingWindow } from './windows.js';

const NOW = new Date('2026-07-03T10:30:00.000Z');
const DAY_MS = 86_400_000;

describe('periodWindow', () => {
  it('resolves today to the current UTC calendar day so far', () => {
    const w = periodWindow({ kind: 'named', period: 'today' }, NOW);
    expect(w.from.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(w.to.toISOString()).toBe(NOW.toISOString());
  });

  it('resolves 7d to the trailing seven days ending now', () => {
    const w = periodWindow({ kind: 'named', period: '7d' }, NOW);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.to.getTime() - w.from.getTime()).toBe(7 * DAY_MS);
  });

  it('resolves 30d to the trailing thirty days ending now', () => {
    const w = periodWindow({ kind: 'named', period: '30d' }, NOW);
    expect(w.to.getTime() - w.from.getTime()).toBe(30 * DAY_MS);
  });

  it('passes a custom range through unchanged', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-15T12:00:00.000Z');
    const w = periodWindow({ kind: 'custom', from, to }, NOW);
    expect(w.from).toEqual(from);
    expect(w.to).toEqual(to);
  });
});

describe('precedingWindow', () => {
  it('is equal-length and immediately preceding for a named window', () => {
    const w = periodWindow({ kind: 'named', period: '7d' }, NOW);
    const p = precedingWindow(w);
    expect(p.to).toEqual(w.from);
    expect(p.to.getTime() - p.from.getTime()).toBe(w.to.getTime() - w.from.getTime());
  });

  it('is equal-length and immediately preceding for an odd-length custom range', () => {
    // 3 days, 7 hours, 13 minutes — no named-period lookup table has this.
    const from = new Date('2026-06-10T04:17:00.000Z');
    const to = new Date('2026-06-13T11:30:00.000Z');
    const p = precedingWindow({ from, to });
    expect(p.to).toEqual(from);
    expect(p.to.getTime() - p.from.getTime()).toBe(to.getTime() - from.getTime());
    expect(p.from.toISOString()).toBe('2026-06-06T21:04:00.000Z');
  });
});
