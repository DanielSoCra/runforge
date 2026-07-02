/**
 * decision-alert — out-of-band operator alert on decision-raise.
 *
 * A single shared helper used at every `ledger.notify` seam (l2-gate, integrate
 * merge-park, finding-dismissal). It fires ONLY when the notify transition
 * actually applies (`applied: true`), giving exactly-once alerting even when the
 * surrounding flow retries. Alert failure is fire-and-forget: it logs a warning
 * but never fails the raise.
 */
import type { NotificationPayload } from './notify.js';

/** The narrow alert surface the helper needs (structurally notifyOperator). */
export type DecisionRaisedAlert = (payload: NotificationPayload) => void | Promise<void>;

export interface AlertContext {
  issueNumber: number;
  decisionId: string;
  /** Sanitized decision title (the question) — no decision body/PHI content. */
  title: string;
  /** Optional dashboard base URL for a deep link; omitted when unset. */
  dashboardBaseUrl?: string;
}

/**
 * Notify the decision index, then alert the operator iff the transition applied.
 * Returns the raw notify result so callers can continue their existing bookkeeping.
 */
export async function alertOnNotifyApplied(
  notify: () => Promise<{ applied: boolean; status: string }>,
  alert: DecisionRaisedAlert | undefined,
  context: AlertContext,
): Promise<{ applied: boolean; status: string }> {
  const result = await notify();
  if (!result.applied || alert === undefined) {
    return result;
  }

  const payload: NotificationPayload = {
    event: 'decision-raised',
    issueNumber: context.issueNumber,
    message: `Decision raised: ${context.title}`,
    decisionId: context.decisionId,
    ...(context.dashboardBaseUrl !== undefined && context.dashboardBaseUrl !== ''
      ? { url: `${context.dashboardBaseUrl.replace(/\/+$/, '')}/steering` }
      : {}),
  };

  try {
    await alert(payload);
  } catch (e) {
    console.warn(
      `[decision-alert] alert failed for ${context.decisionId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return result;
}
