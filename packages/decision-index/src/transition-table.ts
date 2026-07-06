import { TERMINAL_STATUSES, type ItemStatus, type TransitionEvent, type EffectKind } from "@runforge/decision-protocol";

export class IllegalTransitionError extends Error {
  readonly from: ItemStatus;
  readonly event: TransitionEvent;
  constructor(from: ItemStatus, event: TransitionEvent) {
    super(`illegal transition: (${from}) --${event}-->`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

export interface TransitionItem {
  status: ItemStatus;
  stale: boolean;
  resume_mode: "mid_run" | "requeue";
}

export interface TransitionResult {
  /** next durable status (may equal current for flag-only transitions like expire/re_notify). */
  next: ItemStatus;
  /** external effects to enqueue via the outbox (NOT run inside the state txn). */
  effects: EffectKind[];
  /** flag mutations applied alongside the status change. */
  setStale?: boolean;
}

export interface TransitionCtx {
  /** for source_superseded: the new id/etag that supersedes this item. */
  superseded_by?: string;
}

/**
 * Pure §6.2 transition function. Encodes the decision-lifecycle table directly.
 * Unknown (from,event) pairs throw IllegalTransitionError. No I/O here.
 *
 * `answering`/`validated` are audit-only sub-steps and are NOT durable states,
 * so they are not valid `from` states and never appear as `next`.
 */
export function transition(
  item: TransitionItem,
  event: TransitionEvent,
  ctx: TransitionCtx = {},
): TransitionResult {
  const { status } = item;

  switch (event) {
    case "notify":
      if (status === "detected") return { next: "notified", effects: ["notify"] };
      break;

    case "re_notify":
      // re-surface a stale (or simply un-opened) item; stays in place, ping again
      if (status === "notified" || status === "viewed")
        return { next: status, effects: ["notify"] };
      break;

    case "opened":
      if (status === "notified") return { next: "viewed", effects: [] };
      break;

    case "expire":
      // expiry sets the stale flag but is NON-terminal; item stays answerable.
      if (status === "notified" || status === "viewed")
        return { next: status, effects: [], setStale: true };
      break;

    case "answer_submitted":
      // viewed -> answered_pending_source_write; queues the source write.
      // (answer-schema validation + decision_responses insert happen in apply())
      if (status === "viewed")
        return { next: "answered_pending_source_write", effects: ["write_response"] };
      break;

    case "write_response":
      if (status === "answered_pending_source_write")
        return { next: "source_written", effects: [] };
      break;

    case "source_superseded":
    case "precondition_failed":
      // a source change (incl. writeResponse precondition failure, or an edited
      // request block observed by a re-poll) supersedes before any resume.
      // Terminal; NO resume dispatched. A5/I6: legal from ANY non-terminal status
      // — INCLUDING `detected` (a re-poll can see an edited block before the
      // notify effect runs) and `resume_requested`. A terminal item (resumed/
      // superseded/failed) is never re-superseded.
      if (!TERMINAL_STATUSES.has(status)) {
        if (!ctx.superseded_by) {
          throw new Error("source_superseded requires ctx.superseded_by");
        }
        return { next: "superseded", effects: [] };
      }
      break;

    case "resume_dispatch":
      // the ONLY inbound edge to resume is from source_written (no resume before write).
      if (status === "source_written") {
        const kind: EffectKind = item.resume_mode === "requeue" ? "requeue" : "resume";
        return { next: "resume_requested", effects: [kind] };
      }
      break;

    case "resume_ack":
      if (status === "resume_requested") return { next: "resumed", effects: [] };
      break;

    case "answering":
    case "validated":
      // audit-only sub-steps; never a durable transition on their own.
      throw new IllegalTransitionError(status, event);
  }

  throw new IllegalTransitionError(status, event);
}
