// packages/daemon/src/control-plane/steering/decide.ts
//
// Steering — the two PURE deciders (STACK-AC-STEERING).
//
// Total functions over a frozen role + a passed-in snapshot/spend. No clock, no
// I/O, no persistence — `now` arrives via the snapshot and `runningSpend` arrives
// from the cost layer (the window-scheduler `observedAt` / lane-engine passed-in-
// `now` rule). The bodies are STUBBED to throw 'not implemented'; the implementer
// (Kimi) fills them to satisfy the immovable acceptance tests in decide.test.ts.

import { cronDue } from './cron.js';
import type {
  SteeringRole,
  WakeSnapshot,
  WakeDecision,
  SpendVerdict,
} from './types.js';

/**
 * Decide whether a role is due to wake, PURE over its rhythm declaration and the
 * snapshot. A first-ever wake (`snapshot.lastWakingAt` undefined) is `due` — the
 * rhythm has trivially elapsed. For an interval, due iff `now - lastWakingAt >=
 * everyMs`. Exhausts the WakeRhythm union with a `never` default so a future
 * rhythm kind cannot silently fall through to "not due". Reads no clock.
 *
 * A wake for an unknown role is the REGISTRY's `not-found`, not a decider arm —
 * `decideWake` is never called for a role the registry cannot resolve.
 */
export function decideWake(role: SteeringRole, snapshot: WakeSnapshot): WakeDecision {
  const elapsed =
    snapshot.lastWakingAt === undefined ? Infinity : snapshot.now - snapshot.lastWakingAt;

  switch (role.wakeRhythm.kind) {
    case 'interval': {
      return elapsed >= role.wakeRhythm.everyMs
        ? { kind: 'due', reason: 'interval elapsed' }
        : { kind: 'not-due', reason: 'interval not elapsed' };
    }
    case 'cron': {
      // First-ever wake is due for EVERY rhythm (see this function's contract) —
      // a newly activated cron role performs its initial scan on activation, then
      // settles into its cron cadence. `cronDue`'s primitive one-minute lookback
      // would otherwise leave e.g. a daily `0 9 * * *` role first seen at 10:00
      // idle until tomorrow's fire. Mirror the interval arm's `elapsed === Infinity`.
      if (snapshot.lastWakingAt === undefined) {
        return { kind: 'due', reason: 'first-ever cron wake' };
      }
      return cronDue(role.wakeRhythm.expr, snapshot)
        ? { kind: 'due', reason: 'cron fire elapsed' }
        : { kind: 'not-due', reason: 'no cron fire in window' };
    }
    default: {
      const _exhaustive: never = role.wakeRhythm;
      return _exhaustive;
    }
  }
}

/**
 * Decide whether the next step of a waking may spend, bounded by the declared
 * `role.perWakingBudget`. Checks PROJECTED spend (`runningSpend + nextStepCost`)
 * — checking already-spent alone would let a step at 4,900/5,000 proceed for a
 * 200-cost step and blow the budget. If the projection reaches/exceeds budget,
 * returns `conclude-and-record` (the cautious arm — ends the waking CLEANLY,
 * never overspends, never errors); else `proceed`. `nextStepCost` defaults to 0
 * (a pure already-spent check). Performs no accounting itself.
 */
export function checkSpend(
  role: SteeringRole,
  runningSpend: number,
  nextStepCost = 0,
): SpendVerdict {
  // Already at/over the cap concludes; an additional step concludes only if it
  // would STRICTLY exceed the budget. A step that exactly fits the remaining
  // budget is allowed — never strand the last unit.
  return runningSpend >= role.perWakingBudget ||
    runningSpend + nextStepCost > role.perWakingBudget
    ? { kind: 'conclude-and-record', reason: 'per-waking budget reached' }
    : { kind: 'proceed' };
}
