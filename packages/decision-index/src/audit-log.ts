import type { Db } from "./db.js";
import { auditLog } from "./schema.js";
import type { ItemStatus, TransitionEvent } from "@auto-claude/decision-protocol";

/**
 * Slice-4 guarded view-state ops (pin/mute/defer/need_more_context). These are
 * NOT §6.2 transitions and are explicitly NOT in `TRANSITION_EVENTS` — they never
 * change durable status, only the view-state flags. They DO append a redacted
 * audit row, so the audit `event` type is widened to include them.
 */
export const WORKFLOW_AUDIT_EVENTS = ["pin", "mute", "defer", "need_more_context", "reveal"] as const;
export type WorkflowAuditEvent = (typeof WORKFLOW_AUDIT_EVENTS)[number];

export type AuditEvent = TransitionEvent | WorkflowAuditEvent;

export interface AuditEntry {
  decision_id: string;
  from?: ItemStatus | null;
  to?: ItemStatus | null;
  event: AuditEvent;
  transition_key?: string | null;
  actor?: string | null;
  at: string;
  /** redacted detail only — never protected plaintext. */
  detail?: unknown;
  trace_id?: string | null;
}

/** Append one audit row. The caller is responsible for never passing plaintext. */
export function appendAudit(db: Db, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      decision_id: entry.decision_id,
      from_status: entry.from ?? null,
      to_status: entry.to ?? null,
      event: entry.event,
      transition_key: entry.transition_key ?? null,
      actor: entry.actor ?? null,
      at: entry.at,
      detail_json: entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
      trace_id: entry.trace_id ?? null,
    })
    .run();
}
