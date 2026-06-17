// packages/daemon/src/control-plane/steering/cron.ts
//
// Steering — the PURE cron evaluator (STACK-AC-STEERING).
//
// Re-enables cron wake rhythms (follow-up #15): until now `decideWake`'s cron arm
// returned not-due and `schema.ts assembleRole` REJECTED cron at registration,
// because there was no evaluator. This module is that evaluator — pure, no
// `Date.now()` (every timestamp is passed in), no deps. The Control Plane owns the
// clock that supplies `now`; this module only answers "does THIS minute match" and
// "did a fire occur in THIS window" against fixed inputs (the lane-engine /
// window-scheduler passed-in-`now` rule).
//
// ── Cron dialect (the contract — see cron.test.ts) ──────────────────────────
// Standard 5-field cron, UTC: `minute hour day-of-month month day-of-week`.
//   minute 0-59 · hour 0-23 · day-of-month 1-31 · month 1-12 · day-of-week 0-6 (0 = Sunday)
// Each field supports: `*` (any) · `n` (single) · `a-b` (range) · `a,b,c` (list) ·
//   `*/s` (step over the whole field range) · `a-b/s` (stepped range). List items
//   may combine the other forms (e.g. `1,15,30`, `0-10/2,40`).
// DOM/DOW interaction (the standard Vixie-cron quirk): if BOTH day-of-month AND
//   day-of-week are restricted (neither is `*`), a day matches if EITHER matches
//   (OR). If exactly one is `*`, the other is ANDed normally.
//
// A malformed expression is PROGRAMMER ERROR: the schema validated the *shape*
// (non-empty string) but an unparseable field is a bug, so the evaluator THROWS
// (see the cron.test.ts "malformed → throws" cases) rather than silently
// returning not-due. (The deciders never throw on a policy question; an
// unparseable cron expr is not a policy question — it is a malformed declaration
// that should never have been frozen, exactly as a `never`-default would catch a
// future rhythm kind.)

/**
 * The minute-aligned backward-search cap for {@link cronDue}: 44_640 minutes ≈ 31
 * days. Keeps the evaluator pure-AND-bounded — a stale `lastWakingAt` (or a clock
 * jump) can never make the search unbounded. If the window `(lower, now]` exceeds
 * the cap, only the most recent `CRON_SEARCH_CAP_MINUTES` are scanned.
 */
export const CRON_SEARCH_CAP_MINUTES = 44_640;

/** One whole minute in milliseconds — the cron resolution. */
export const MINUTE_MS = 60_000;

type CronFieldRange = { min: number; max: number };

const MINUTE_RANGE: CronFieldRange = { min: 0, max: 59 };
const HOUR_RANGE: CronFieldRange = { min: 0, max: 23 };
const DOM_RANGE: CronFieldRange = { min: 1, max: 31 };
const MONTH_RANGE: CronFieldRange = { min: 1, max: 12 };
const DOW_RANGE: CronFieldRange = { min: 0, max: 6 };

function assertInteger(value: number, token: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`cron: non-integer value "${token}"`);
  }
}

function parseSingleValue(token: string, range: CronFieldRange): number {
  const value = Number(token);
  if (Number.isNaN(value)) {
    throw new Error(`cron: non-numeric value "${token}"`);
  }
  assertInteger(value, token);
  if (value < range.min || value > range.max) {
    throw new Error(`cron: value ${value} out of range ${range.min}-${range.max}`);
  }
  return value;
}

function parseRangeBound(token: string, range: CronFieldRange): number {
  return parseSingleValue(token, range);
}

function parseStep(token: string): number {
  const step = Number(token);
  if (Number.isNaN(step)) {
    throw new Error(`cron: non-numeric step "${token}"`);
  }
  assertInteger(step, token);
  if (step <= 0) {
    throw new Error(`cron: step must be positive, got ${step}`);
  }
  return step;
}

function addRange(
  set: Set<number>,
  start: number,
  end: number,
  step: number,
  range: CronFieldRange,
): void {
  if (start < range.min || end > range.max || start > end) {
    throw new Error(`cron: invalid range ${start}-${end}/${step}`);
  }
  for (let value = start; value <= end; value += step) {
    set.add(value);
  }
}

function parseField(field: string, range: CronFieldRange): Set<number> {
  if (field === '') {
    throw new Error('cron: empty field');
  }

  const set = new Set<number>();
  const items = field.split(',');

  for (const item of items) {
    if (item === '') {
      throw new Error('cron: empty list item');
    }

    if (item === '*') {
      addRange(set, range.min, range.max, 1, range);
      continue;
    }

    if (item.includes('/')) {
      const stepParts = item.split('/');
      if (stepParts.length !== 2) {
        throw new Error(`cron: malformed step item "${item}" (expected exactly one '/')`);
      }
      const [rangePart, stepToken] = stepParts;
      if (stepToken === undefined || rangePart === undefined) {
        throw new Error(`cron: malformed step item "${item}"`);
      }
      const step = parseStep(stepToken);

      let start: number;
      let end: number;
      if (rangePart === '*') {
        start = range.min;
        end = range.max;
      } else if (rangePart.includes('-')) {
        const [startToken, endToken] = rangePart.split('-');
        if (startToken === undefined || endToken === undefined || startToken === '' || endToken === '') {
          throw new Error(`cron: malformed range "${rangePart}"`);
        }
        start = parseRangeBound(startToken, range);
        end = parseRangeBound(endToken, range);
      } else {
        start = parseRangeBound(rangePart, range);
        end = range.max;
      }
      addRange(set, start, end, step, range);
      continue;
    }

    if (item.includes('-')) {
      const [startToken, endToken] = item.split('-');
      if (startToken === undefined || endToken === undefined || startToken === '' || endToken === '') {
        throw new Error(`cron: malformed range "${item}"`);
      }
      const start = parseRangeBound(startToken, range);
      const end = parseRangeBound(endToken, range);
      addRange(set, start, end, 1, range);
      continue;
    }

    set.add(parseSingleValue(item, range));
  }

  return set;
}

function parseCronExpression(expr: string): {
  minuteSet: Set<number>;
  hourSet: Set<number>;
  domSet: Set<number>;
  monthSet: Set<number>;
  dowSet: Set<number>;
  domField: string;
  dowField: string;
} {
  const rawFields = expr.trim().split(/\s+/);
  if (rawFields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${rawFields.length}`);
  }

  const [minuteField, hourField, domField, monthField, dowField] = rawFields;
  if (
    minuteField === undefined ||
    hourField === undefined ||
    domField === undefined ||
    monthField === undefined ||
    dowField === undefined
  ) {
    throw new Error('cron: missing field after split');
  }

  return {
    minuteSet: parseField(minuteField, MINUTE_RANGE),
    hourSet: parseField(hourField, HOUR_RANGE),
    domSet: parseField(domField, DOM_RANGE),
    monthSet: parseField(monthField, MONTH_RANGE),
    dowSet: parseField(dowField, DOW_RANGE),
    domField,
    dowField,
  };
}

/**
 * Whether `expr` is a parseable 5-field cron expression. For FAIL-CLOSED validation
 * at registration: a malformed cron must be rejected as an offender, never accepted
 * and then thrown at the first wake evaluation. Parses every field (no short-circuit).
 */
export function isValidCronExpr(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the UTC minute CONTAINING `utcMs` satisfies the cron expression. The
 * seconds and milliseconds of `utcMs` are ignored — only its minute, hour,
 * day-of-month, month, and day-of-week (all UTC) are tested, against the dialect
 * documented at the top of this file (including the DOM/DOW OR-quirk). PURE: reads
 * no clock; `utcMs` is the only time input. Throws on a malformed expression.
 *
 * @param expr  a standard 5-field cron expression (UTC)
 * @param utcMs a unix-epoch millisecond timestamp; its UTC minute is the one tested
 */
export function cronMatchesAt(expr: string, utcMs: number): boolean {
  const { minuteSet, hourSet, domSet, monthSet, dowSet, domField, dowField } =
    parseCronExpression(expr);

  const date = new Date(utcMs);
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  if (!minuteSet.has(minute) || !hourSet.has(hour) || !monthSet.has(month)) {
    return false;
  }

  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  if (domRestricted && dowRestricted) {
    return domSet.has(dom) || dowSet.has(dow);
  }

  return domSet.has(dom) && dowSet.has(dow);
}

/**
 * Whether a cron fire-time occurred in the wake window — i.e. whether there EXISTS
 * a minute-aligned timestamp `m` with `lower < m <= snapshot.now` such that
 * `cronMatchesAt(expr, m)`, where:
 *
 *   lower = snapshot.lastWakingAt ?? (snapshot.now - 60_000)
 *
 * A first-ever wake (`snapshot.lastWakingAt` undefined) looks back exactly one
 * minute so the CURRENT tick can fire if it matches (the interval decider's
 * "first-ever is due" analogue, expressed as a one-minute lookback). The boundary
 * is inclusive at the TOP (`m <= now`: a fire exactly at `now`'s minute counts)
 * and exclusive at the BOTTOM (`lower < m`: the minute already consumed by the
 * previous waking does not re-fire). The backward search is bounded to
 * {@link CRON_SEARCH_CAP_MINUTES}; a window wider than the cap searches only its
 * most recent cap minutes. PURE: reads no clock. Throws on a malformed expression.
 *
 * @param expr     a standard 5-field cron expression (UTC)
 * @param snapshot { now, lastWakingAt? } — the same WakeSnapshot shape decideWake reads
 */
export function cronDue(
  expr: string,
  snapshot: { now: number; lastWakingAt?: number },
): boolean {
  const { now, lastWakingAt } = snapshot;
  const lower = lastWakingAt === undefined ? now - MINUTE_MS : lastWakingAt;

  const nowIdx = Math.floor(now / MINUTE_MS);
  const lowerIdx = Math.floor(lower / MINUTE_MS);

  // The first minute-aligned timestamp strictly greater than `lower` has index
  // `lowerIdx + 1`. The search is also bounded to the most recent cap minutes.
  const earliestIdx = Math.max(
    lowerIdx + 1,
    nowIdx - CRON_SEARCH_CAP_MINUTES + 1,
  );

  for (let idx = nowIdx; idx >= earliestIdx; idx -= 1) {
    if (cronMatchesAt(expr, idx * MINUTE_MS)) {
      return true;
    }
  }

  return false;
}
