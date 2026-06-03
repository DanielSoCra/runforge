/**
 * reconcile — the daemon-side lifecycle maintenance for the decision-escalation
 * index (fold plan Task 6). Three fail-safe operations the daemon invokes at
 * well-defined points:
 *
 *   - `bootReconcile(manager)`  — at startup, AFTER `manager.init()`: complete any
 *     in-flight outbox effects a prior crash left mid-flight.
 *   - `supersedeIfMoot(ledger, id)` — when the daemon detects a decision has gone
 *     moot (its issue closed / run completed / it left the gate by another path):
 *     drive the `source_superseded` event, guarded so a missing/terminal row is a
 *     no-op rather than a throw.
 *   - `markOverdue(ledger, now)` — in the tick loop: mark past-`expires_at`
 *     `notified`/`viewed` items stale via the `expire` event (mark only; no
 *     delivery/notification — that is deferred).
 *
 * EVERY operation is fail-safe: an error is logged, never re-thrown, so a
 * reconcile/supersede/overdue failure can never crash the daemon. The
 * enabled-guard for `bootReconcile`/`markOverdue` lives at the wiring sites (the
 * daemon checks `manager.isEnabled()`); `bootReconcile` additionally short-circuits
 * on a disabled manager so it is safe to call unconditionally at boot.
 */
import type { DecisionIndexManager } from './manager.js';
import type { DecisionLedger } from './ledger.js';

const LOG_PREFIX = '[decision-escalation]';

/**
 * bootReconcile — at startup, complete in-flight effects. No-op (and NEVER throws,
 * never touches the ledger) when the manager is disabled; fail-safe (logs, does
 * not throw) when an enabled reconcile errors so a broken index cannot abort boot.
 */
export async function bootReconcile(manager: DecisionIndexManager): Promise<void> {
  if (!manager.isEnabled()) return;
  try {
    await manager.ledger().reconcile();
  } catch (err) {
    console.error(`${LOG_PREFIX} boot reconcile failed (continuing): ${String(err)}`);
  }
}

/**
 * supersedeIfMoot — supersede a now-moot decision (issue closed / run completed).
 * The ledger applies the §6.2 `source_superseded` event ONLY when the row is
 * present and non-terminal (it SKIPS a missing/undefined or terminal row — see
 * `DecisionLedger.supersede`), so this wrapper just adds fail-safe error handling.
 */
export async function supersedeIfMoot(
  ledger: DecisionLedger,
  decisionId: string,
): Promise<void> {
  try {
    ledger.supersede(decisionId);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} supersede-on-moot failed for ${decisionId} (continuing): ${String(err)}`,
    );
  }
}

/**
 * markOverdue — mark every past-`expires_at` `notified`/`viewed` decision stale
 * via the §6.2 `expire` event. The ledger filters to exactly the two states
 * `expire` is legal from and is idempotent per (id, expiry); this wrapper adds
 * fail-safe error handling so an overdue sweep cannot crash the tick loop.
 */
export async function markOverdue(ledger: DecisionLedger, now: Date): Promise<void> {
  try {
    ledger.expireOverdue(now);
  } catch (err) {
    console.error(`${LOG_PREFIX} overdue marking failed (continuing): ${String(err)}`);
  }
}
