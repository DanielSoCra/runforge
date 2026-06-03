/**
 * §6.2 state-machine vocabulary, shared by protocol consumers.
 *
 * IMPORTANT: `answering` and `validated` are NOT durable statuses — they are
 * audit-only sub-steps recorded as TransitionEvent values inside the single
 * accepted `answer_submitted` transaction. `stale` is a boolean flag on the
 * item, never a status.
 */

export const ITEM_STATUSES = [
  "detected",
  "notified",
  "viewed",
  "answered_pending_source_write",
  "source_written",
  "resume_requested",
  "resumed", // terminal
  "superseded", // terminal
  "failed", // terminal
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "resumed",
  "superseded",
  "failed",
]);

/**
 * Events that drive transitions. Includes the audit-only `answering`/`validated`
 * sub-steps which appear in the audit_log but never as durable statuses.
 */
export const TRANSITION_EVENTS = [
  "notify",
  "opened",
  "answer_submitted",
  "answering", // audit-only sub-step
  "validated", // audit-only sub-step
  "write_response",
  "resume_dispatch",
  "resume_ack",
  "source_superseded",
  "expire",
  "re_notify",
  "precondition_failed",
  "fail", // audit-only escalation; NOT a §6.2 transition-table edge (never a durable `from`)
] as const;
export type TransitionEvent = (typeof TRANSITION_EVENTS)[number];

export const RISK_CLASSES = ["P0", "P1", "P2", "P3"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const RESUME_MODES = ["mid_run", "requeue"] as const;
export type ResumeMode = (typeof RESUME_MODES)[number];

export const REVERSIBILITY = ["reversible", "hard_to_reverse", "external_effect"] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];

/** Effect kinds the two-phase outbox manages; every kind is deterministic-id + probeable. */
export const EFFECT_KINDS = ["write_response", "resume", "requeue", "notify"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
