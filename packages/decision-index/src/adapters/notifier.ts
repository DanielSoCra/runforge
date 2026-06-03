export type ProbeResult = "applied" | "absent" | "unknown";

export interface NotifyArgs {
  decision_id: string;
  channel: string;
  effectId: string;
}

/**
 * Notifier — naturally idempotent (a duplicate ping is acceptable, deduped by
 * last_notified_at). Probe reports `applied` once a notification was sent.
 *
 * Async (slice 2): real adapters (e.g. a logging/Slack notifier) perform I/O, so
 * the contract returns Promises. The pure state machine stays synchronous — the
 * outbox only awaits adapters in its *execute* phase, never inside a SQLite txn.
 */
export interface Notifier {
  notify(args: NotifyArgs): Promise<"sent" | "failed">;
  probe(effectId: string): Promise<ProbeResult>;
}
