// packages/daemon/src/control-plane/steering/cron.test.ts
//
// IMMOVABLE acceptance contract for the pure cron evaluator (STACK-AC-STEERING,
// follow-up #15). All behavioral — these FAIL (red) at handoff because
// cronMatchesAt / cronDue throw 'not implemented'. Kimi fills the bodies to make
// them pass; the tests may NOT be weakened.
//
// Every timestamp is a FIXED UTC instant via Date.UTC(...) — NEVER the live clock.
// The evaluator is pure over (expr, utcMs) / (expr, snapshot), so the same inputs
// always give the same answer; a test that read Date.now() would be untestable and
// non-deterministic (the lane-engine / window-scheduler passed-in-`now` rule).
//
// Dialect under test (5-field, UTC): `minute hour day-of-month month day-of-week`,
// ranges minute 0-59 · hour 0-23 · dom 1-31 · month 1-12 · dow 0-6 (0 = Sunday).
// Forms: `*`, `n`, `a-b`, `a,b,c`, `*/s`, `a-b/s`, and lists combining them.
// DOM/DOW quirk: if BOTH dom and dow are restricted, a day matches if EITHER does.
import { describe, it, expect } from 'vitest';
import { cronMatchesAt, cronDue, MINUTE_MS } from './cron.js';

// ── Anchor instants (all confirmed UTC) ────────────────────────────────────
// 2024-01-01 00:00 UTC is BOTH the 1st of the month AND a Monday (dow 1) — the
// natural anchor for the DOM/DOW OR-quirk. 2024-01-02 is the 2nd / a Tuesday.
const JAN1_0000 = Date.UTC(2024, 0, 1, 0, 0); //  1st, Monday,   00:00
const JAN1_0030 = Date.UTC(2024, 0, 1, 0, 30); //  1st, Monday,   00:30
const JAN1_0900 = Date.UTC(2024, 0, 1, 9, 0); //  1st, Monday,   09:00
const JAN1_1000 = Date.UTC(2024, 0, 1, 10, 0); //  1st, Monday,   10:00
const JAN1_1200 = Date.UTC(2024, 0, 1, 12, 0); //  1st, Monday,   12:00
const JAN2_0000 = Date.UTC(2024, 0, 2, 0, 0); //  2nd, Tuesday,  00:00
const JAN2_1200 = Date.UTC(2024, 0, 2, 12, 0); //  2nd, Tuesday,  12:00
const JAN8_0000 = Date.UTC(2024, 0, 8, 0, 0); //  8th, Monday,   00:00
const JAN8_1200 = Date.UTC(2024, 0, 8, 12, 0); //  8th, Monday,   12:00

describe('cronMatchesAt — minute field', () => {
  it("'0 * * * *' matches HH:00", () => {
    expect(cronMatchesAt('0 * * * *', JAN1_0000)).toBe(true);
    expect(cronMatchesAt('0 * * * *', JAN1_0900)).toBe(true);
  });

  it("'0 * * * *' does NOT match HH:30", () => {
    expect(cronMatchesAt('0 * * * *', JAN1_0030)).toBe(false);
  });

  it("seconds/ms within the minute are ignored (the minute containing utcMs is tested)", () => {
    // 00:00:45.123 is still the 00:00 minute → matches '0 * * * *'.
    expect(cronMatchesAt('0 * * * *', Date.UTC(2024, 0, 1, 0, 0, 45, 123))).toBe(true);
    // 00:30:59.999 is still the 00:30 minute → does NOT match '0 * * * *'.
    expect(cronMatchesAt('0 * * * *', Date.UTC(2024, 0, 1, 0, 30, 59, 999))).toBe(false);
  });
});

describe('cronMatchesAt — step (*/s)', () => {
  it("'*/15 * * * *' matches :00, :15, :30, :45", () => {
    expect(cronMatchesAt('*/15 * * * *', Date.UTC(2024, 0, 1, 8, 0))).toBe(true);
    expect(cronMatchesAt('*/15 * * * *', Date.UTC(2024, 0, 1, 8, 15))).toBe(true);
    expect(cronMatchesAt('*/15 * * * *', Date.UTC(2024, 0, 1, 8, 30))).toBe(true);
    expect(cronMatchesAt('*/15 * * * *', Date.UTC(2024, 0, 1, 8, 45))).toBe(true);
  });

  it("'*/15 * * * *' does NOT match :07", () => {
    expect(cronMatchesAt('*/15 * * * *', Date.UTC(2024, 0, 1, 8, 7))).toBe(false);
  });
});

describe('cronMatchesAt — hour field', () => {
  it("'0 9 * * *' matches 09:00 UTC", () => {
    expect(cronMatchesAt('0 9 * * *', JAN1_0900)).toBe(true);
  });

  it("'0 9 * * *' does NOT match 10:00 UTC", () => {
    expect(cronMatchesAt('0 9 * * *', JAN1_1000)).toBe(false);
  });

  it("'0 9 * * *' does NOT match 09:30 (minute must also match)", () => {
    expect(cronMatchesAt('0 9 * * *', Date.UTC(2024, 0, 1, 9, 30))).toBe(false);
  });
});

describe('cronMatchesAt — day-of-month field', () => {
  it("'0 0 1 * *' matches the 1st at 00:00", () => {
    expect(cronMatchesAt('0 0 1 * *', JAN1_0000)).toBe(true);
  });

  it("'0 0 1 * *' does NOT match the 2nd at 00:00", () => {
    expect(cronMatchesAt('0 0 1 * *', JAN2_0000)).toBe(false);
  });
});

describe('cronMatchesAt — day-of-week field', () => {
  it("'0 12 * * 1' (Monday noon) matches a known Monday", () => {
    expect(cronMatchesAt('0 12 * * 1', JAN1_1200)).toBe(true); // Jan 1 2024 is a Monday
    expect(cronMatchesAt('0 12 * * 1', JAN8_1200)).toBe(true); // Jan 8 2024 is a Monday
  });

  it("'0 12 * * 1' (Monday noon) does NOT match a Tuesday", () => {
    expect(cronMatchesAt('0 12 * * 1', JAN2_1200)).toBe(false); // Jan 2 2024 is a Tuesday
  });
});

describe('cronMatchesAt — month field', () => {
  it("'0 0 1 1 *' matches Jan 1 but not a Feb 1", () => {
    expect(cronMatchesAt('0 0 1 1 *', JAN1_0000)).toBe(true);
    expect(cronMatchesAt('0 0 1 1 *', Date.UTC(2024, 1, 1, 0, 0))).toBe(false); // Feb 1
  });
});

describe('cronMatchesAt — DOM/DOW OR-quirk (both restricted ⇒ EITHER matches)', () => {
  // '0 0 1 * 1' — midnight on (the 1st) OR (any Monday).
  it('matches the 1st even when it is NOT the named weekday', () => {
    // Make a year where the 1st is not a Monday: 2025-01-01 is a Wednesday.
    const wed1st = Date.UTC(2025, 0, 1, 0, 0);
    expect(new Date(wed1st).getUTCDay()).not.toBe(1); // sanity: not Monday
    expect(cronMatchesAt('0 0 1 * 1', wed1st)).toBe(true); // matches via DOM
  });

  it('matches a Monday even when it is NOT the 1st', () => {
    // Jan 8 2024 is a Monday and the 8th (not the 1st) → matches via DOW.
    expect(cronMatchesAt('0 0 1 * 1', JAN8_0000)).toBe(true);
  });

  it('matches Jan 1 2024 (BOTH the 1st AND a Monday)', () => {
    expect(cronMatchesAt('0 0 1 * 1', JAN1_0000)).toBe(true);
  });

  it('does NOT match a day that is neither the 1st nor a Monday', () => {
    // Jan 2 2024 is the 2nd and a Tuesday → neither branch matches.
    expect(cronMatchesAt('0 0 1 * 1', JAN2_0000)).toBe(false);
  });

  it('when DOM is restricted but DOW is `*`, the day is ANDed normally (only the 1st)', () => {
    expect(cronMatchesAt('0 0 1 * *', JAN1_0000)).toBe(true); // the 1st
    expect(cronMatchesAt('0 0 1 * *', JAN8_0000)).toBe(false); // the 8th (a Monday) does NOT match
  });

  it('when DOW is restricted but DOM is `*`, the day is ANDed normally (only Mondays)', () => {
    expect(cronMatchesAt('0 0 * * 1', JAN1_0000)).toBe(true); // Monday
    expect(cronMatchesAt('0 0 * * 1', JAN2_0000)).toBe(false); // Tuesday
  });
});

describe('cronMatchesAt — list (a,b,c)', () => {
  it("'0,30 * * * *' matches :00 and :30 but not :15", () => {
    expect(cronMatchesAt('0,30 * * * *', JAN1_0000)).toBe(true); // :00
    expect(cronMatchesAt('0,30 * * * *', JAN1_0030)).toBe(true); // :30
    expect(cronMatchesAt('0,30 * * * *', Date.UTC(2024, 0, 1, 0, 15))).toBe(false); // :15
  });
});

describe('cronMatchesAt — range (a-b)', () => {
  it("'0 9-17 * * *' matches the top of the hour within 09..17 inclusive", () => {
    expect(cronMatchesAt('0 9-17 * * *', JAN1_0900)).toBe(true); // 09:00 (low bound)
    expect(cronMatchesAt('0 9-17 * * *', Date.UTC(2024, 0, 1, 13, 0))).toBe(true); // 13:00 (inside)
    expect(cronMatchesAt('0 9-17 * * *', Date.UTC(2024, 0, 1, 17, 0))).toBe(true); // 17:00 (high bound)
  });

  it("'0 9-17 * * *' does NOT match an hour outside the range", () => {
    expect(cronMatchesAt('0 9-17 * * *', JAN1_0000)).toBe(false); // 00:00 (below)
    expect(cronMatchesAt('0 9-17 * * *', Date.UTC(2024, 0, 1, 18, 0))).toBe(false); // 18:00 (above)
  });
});

describe('cronMatchesAt — stepped range (a-b/s)', () => {
  it("'0 9-17/2 * * *' matches 09, 11, 13, 15, 17 but not 10", () => {
    expect(cronMatchesAt('0 9-17/2 * * *', Date.UTC(2024, 0, 1, 9, 0))).toBe(true);
    expect(cronMatchesAt('0 9-17/2 * * *', Date.UTC(2024, 0, 1, 11, 0))).toBe(true);
    expect(cronMatchesAt('0 9-17/2 * * *', Date.UTC(2024, 0, 1, 17, 0))).toBe(true);
    expect(cronMatchesAt('0 9-17/2 * * *', Date.UTC(2024, 0, 1, 10, 0))).toBe(false);
  });
});

describe('cronMatchesAt — malformed expression throws (programmer error)', () => {
  // The schema validated the SHAPE (non-empty string); an unparseable field is a
  // bug that should never have been frozen. The evaluator throws rather than
  // silently returning not-due (mirrors the decider's `never`-default guard).
  it('too few fields throws', () => {
    expect(() => cronMatchesAt('0 9 * *', JAN1_0900)).toThrow();
  });

  it('too many fields throws', () => {
    expect(() => cronMatchesAt('0 9 * * * *', JAN1_0900)).toThrow();
  });

  it('a non-numeric field throws', () => {
    expect(() => cronMatchesAt('x 9 * * *', JAN1_0900)).toThrow();
  });

  it('an out-of-range value throws (minute 60)', () => {
    expect(() => cronMatchesAt('60 * * * *', JAN1_0000)).toThrow();
  });

  it('an out-of-range value throws (hour 24)', () => {
    expect(() => cronMatchesAt('0 24 * * *', JAN1_0000)).toThrow();
  });

  it('an out-of-range value throws (day-of-week 7)', () => {
    expect(() => cronMatchesAt('0 0 * * 7', JAN1_0000)).toThrow();
  });

  it('a step field with repeated "/" throws, never silently parsed as */5 (codex)', () => {
    expect(() => cronMatchesAt('*/5/2 * * * *', JAN1_0000)).toThrow();
  });

  it('Number()-coercible non-integer tokens throw, not silently coerced (codex)', () => {
    expect(() => cronMatchesAt('/5 * * * *', JAN1_0000)).toThrow(); // empty range token → not 0
    expect(() => cronMatchesAt('1e1 * * * *', JAN1_0000)).toThrow(); // exponent → not minute 10
    expect(() => cronMatchesAt('5.0 * * * *', JAN1_0000)).toThrow(); // decimal → not 5
  });

  it('a range with extra bounds throws, never silently parsed as a-b (codex)', () => {
    expect(() => cronMatchesAt('0 1-2-3 * * *', JAN1_0000)).toThrow();
  });
});

describe('cronDue — window existence (lower < m <= now)', () => {
  it('first-ever (lastWakingAt undefined) at a matching minute → true', () => {
    // now is exactly 09:00 (a fire minute for '0 9 * * *'); the one-minute lookback
    // window (09:00-60_000 , 09:00] includes the 09:00 minute itself.
    expect(cronDue('0 9 * * *', { now: JAN1_0900 })).toBe(true);
  });

  it('first-ever (lastWakingAt undefined) at a NON-matching minute → false', () => {
    // now is 10:00; the only candidate in the one-minute lookback is the 10:00
    // minute (and a sub-minute back), neither of which matches '0 9 * * *'.
    expect(cronDue('0 9 * * *', { now: JAN1_1000 })).toBe(false);
  });

  it('a fire occurred since lastWakingAt → true', () => {
    // Hourly fire '0 * * * *'. last waking at 08:30, now at 09:30 → the 09:00 fire
    // lies strictly inside (08:30, 09:30].
    const last = Date.UTC(2024, 0, 1, 8, 30);
    const now = Date.UTC(2024, 0, 1, 9, 30);
    expect(cronDue('0 * * * *', { now, lastWakingAt: last })).toBe(true);
  });

  it('no fire since lastWakingAt → false', () => {
    // Hourly fire. last waking at 09:05, now at 09:55 → no HH:00 minute in
    // (09:05, 09:55]; the 09:00 fire is at-or-before lower and excluded.
    const last = Date.UTC(2024, 0, 1, 9, 5);
    const now = Date.UTC(2024, 0, 1, 9, 55);
    expect(cronDue('0 * * * *', { now, lastWakingAt: last })).toBe(false);
  });

  it('boundary: a fire exactly at now’s minute → true (top bound inclusive)', () => {
    // last waking at 08:00, now exactly at the 09:00 fire minute → 09:00 ∈ (08:00, 09:00].
    const last = Date.UTC(2024, 0, 1, 8, 0);
    const now = JAN1_0900;
    expect(cronDue('0 * * * *', { now, lastWakingAt: last })).toBe(true);
  });

  it('boundary: a fire exactly at lower is EXCLUDED (bottom bound exclusive)', () => {
    // The minute already consumed by the previous waking must not re-fire: last
    // waking exactly at the 09:00 fire, now one minute later → (09:00, 09:01] holds
    // no HH:00 minute, so not due.
    const last = JAN1_0900;
    const now = JAN1_0900 + MINUTE_MS;
    expect(cronDue('0 * * * *', { now, lastWakingAt: last })).toBe(false);
  });

  it('within-minute now still fires for a matching minute (now’s seconds ignored)', () => {
    // now at 09:00:45 (still the 09:00 minute), first-ever → due.
    expect(cronDue('0 9 * * *', { now: Date.UTC(2024, 0, 1, 9, 0, 45, 0) })).toBe(true);
  });

  it('a window wider than the search cap still fires on a recent matching minute', () => {
    // lastWakingAt absurdly far in the past (well beyond the 31-day cap); an hourly
    // cron still has a fire within the last cap minutes → due (bounded search finds it).
    const now = Date.UTC(2024, 6, 1, 9, 0); // a HH:00 minute, mid-year
    const last = Date.UTC(2020, 0, 1, 0, 0); // ~4.5 years earlier (>> cap)
    expect(cronDue('0 * * * *', { now, lastWakingAt: last })).toBe(true);
  });
});

describe('cronDue — malformed expression throws (programmer error)', () => {
  it('propagates the malformed-expr throw from cronMatchesAt', () => {
    expect(() => cronDue('not a cron', { now: JAN1_0900 })).toThrow();
  });
});
