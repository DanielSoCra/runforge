/**
 * STACK-AC-SPEND-OBSERVABILITY — period windowing.
 *
 * The ONE place that resolves a period to a `{ from, to }` window and derives
 * the immediately-preceding equal-length window (L3 Key Decision: "Period
 * windowing + preceding-equal-length delta live in one place"). Every headline
 * delta is computed against `precedingWindow(...)` — never re-derived per
 * handler, never from a named-period lookup table (which has no entry for a
 * custom range).
 *
 * Named periods need a clock; `now` is INJECTED (no `Date.now()` on the read
 * path — house rule) so the resolution is a pure function of its arguments.
 */
import type { PeriodQuery, Window } from './types.js';

const DAY_MS = 86_400_000;

/** Resolve a validated period query to a half-open `[from, to)` window. */
export function periodWindow(query: PeriodQuery, now: Date): Window {
  if (query.kind === 'custom') {
    return { from: query.from, to: query.to };
  }
  if (query.period === 'today') {
    // The current UTC calendar day so far.
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    return { from, to: now };
  }
  const days = query.period === '7d' ? 7 : 30;
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

/**
 * The equal-length window immediately before `w` — computed from the RESOLVED
 * window length so it holds for custom ranges too (L3 gotcha).
 */
export function precedingWindow(w: Window): Window {
  const len = w.to.getTime() - w.from.getTime();
  return { from: new Date(w.from.getTime() - len), to: w.from };
}
