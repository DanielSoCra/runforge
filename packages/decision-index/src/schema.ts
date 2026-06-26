/**
 * Drizzle Postgres schema (spec §3.2). Ported from sqlite-core to pg-core.
 *
 * All tables live in a dedicated `decision_index` Postgres schema (pgSchema) to
 * keep a hard namespace boundary from packages/db's `public` tables.
 *
 * Invariants encoded structurally (unchanged from the sqlite port):
 *  - decision_responses PK = decision_id           => answered-once (DB-enforced)
 *  - applied_transitions PK = (decision_id, transition_key) => idempotent transitions
 *  - outbox PK = id (deterministic <decision_id>:<kind>:<semantic_key>)
 *  - NO plaintext PHI/secret and NO plaintext-hash columns anywhere
 *    (protected_refs holds only the ulid+class; integrity HMAC lives in the
 *     encrypted blob file outside Postgres).
 *
 * Mapping notes (spec §3.2):
 *  - integer({mode:"boolean"})            -> boolean()
 *  - integer().primaryKey({autoIncrement}) -> bigint(...).generatedAlwaysAsIdentity()
 *  - ISO-8601 timestamps stored as text   -> KEEP as text() (zero behavioral drift)
 */
import {
  pgSchema,
  text,
  boolean,
  bigint,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";

/** Dedicated Postgres schema namespace for the decision index. */
export const decisionIndex = pgSchema("decision_index");

/** Durable inbox item. All PHI/secret values already redacted to protected:// refs. */
export const decisions = decisionIndex.table("decisions", {
  decision_id: text("decision_id").primaryKey(),
  protocol_version: text("protocol_version").notNull(),
  status: text("status").notNull(),
  source_url: text("source_url").notNull(),
  source_etag: text("source_etag"),
  source_event_id: text("source_event_id"),
  deployment: text("deployment").notNull(),
  run_id: text("run_id").notNull(),
  worker_session_id: text("worker_session_id"),
  phase: text("phase"),
  risk_class: text("risk_class").notNull(),
  // already-redacted request payload (protected:// refs in place of phi/secret values)
  question: text("question").notNull(),
  context: text("context"),
  options_json: text("options_json").notNull(),
  recommended_option: text("recommended_option"),
  consequence_of_no_answer: text("consequence_of_no_answer"),
  reversibility: text("reversibility"),
  answer_schema_json: text("answer_schema_json").notNull(),
  resume_mode: text("resume_mode").notNull(),
  idempotency_key: text("idempotency_key").notNull(),
  trace_id: text("trace_id"),
  agent_version: text("agent_version"),
  skill_version: text("skill_version"),
  // lifecycle / observability
  expires_at: text("expires_at"),
  last_seen_at: text("last_seen_at"),
  last_notified_at: text("last_notified_at"),
  stale: boolean("stale").notNull().default(false),
  superseded_by: text("superseded_by"),
  pinned: boolean("pinned").notNull().default(false),
  muted: boolean("muted").notNull().default(false),
  deferred_until: text("deferred_until"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/** Answered-once: PK = decision_id. */
export const decisionResponses = decisionIndex.table("decision_responses", {
  decision_id: text("decision_id")
    .primaryKey()
    .references(() => decisions.decision_id),
  response_idempotency_key: text("response_idempotency_key").notNull(),
  response_hash: text("response_hash").notNull(),
  chosen_option: text("chosen_option"),
  answer_ref: text("answer_ref"),
  // C1 (PHI-safe posting): the REDACTED, non-sensitive answer the sink may post
  // back (a chosen_option id, or a public/internal JSON answer value as JSON).
  // For a phi/secret answer this is NULL — only `answer_ref` is stored and the
  // sink posts an acknowledgement referencing the protected store, never plaintext.
  response_payload_json: text("response_payload_json"),
  answerer: text("answerer").notNull(),
  answered_at: text("answered_at").notNull(),
});

/** Idempotent transition ledger: existence of a row = "already applied". */
export const appliedTransitions = decisionIndex.table(
  "applied_transitions",
  {
    decision_id: text("decision_id")
      .notNull()
      .references(() => decisions.decision_id),
    transition_key: text("transition_key").notNull(),
    applied_at: text("applied_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.decision_id, t.transition_key] }),
  }),
);

/** Append-only audit trail; detail_json is always redacted. */
export const auditLog = decisionIndex.table("audit_log", {
  id: bigint("id", { mode: "number" })
    .primaryKey()
    .generatedAlwaysAsIdentity(),
  decision_id: text("decision_id")
    .notNull()
    .references(() => decisions.decision_id),
  from_status: text("from_status"),
  to_status: text("to_status"),
  event: text("event").notNull(),
  transition_key: text("transition_key"),
  actor: text("actor"),
  at: text("at").notNull(),
  detail_json: text("detail_json"),
  trace_id: text("trace_id"),
});

/** Two-phase outbox; PK id is deterministic and reconstructable from item state. */
export const outbox = decisionIndex.table("outbox", {
  id: text("id").primaryKey(),
  decision_id: text("decision_id")
    .notNull()
    .references(() => decisions.decision_id),
  kind: text("kind").notNull(),
  intended_transition: text("intended_transition").notNull(),
  // Finding I6: the transition semantic key (e.g. a re_notify cycle token) carried
  // EXPLICITLY so reconcile recovers it from this column — never by string-splitting
  // the deterministic id (a cycle token may itself contain ':', e.g. an ISO-8601
  // timestamp, which a split would truncate, breaking idempotency/audit).
  semantic_key: text("semantic_key"),
  payload_ref: text("payload_ref"),
  state: text("state").notNull(), // reserved | executing | committed | failed
  // CRITICAL 1: lease timestamp set when a row is CAS-claimed (reserved ->
  // executing) before any adapter await. Reconcile only RE-claims an `executing`
  // row whose claim is older than the lease window (a crashed process leaves an
  // orphaned executing row); a freshly-claimed (live, in-flight) row is NOT
  // stolen, so a concurrent reconcile defers instead of double-dispatching.
  claimed_at: text("claimed_at"),
  // CRITICAL 1 (owner/generation token): the per-process generation id that
  // CAS-claimed the row (`reserved -> executing`). Reconcile may RE-claim an
  // `executing` row ONLY if its `claimed_by` is a DIFFERENT generation (a prior,
  // dead process) — it NEVER steals an `executing` row owned by the current live
  // process, regardless of the lease. The current process serializes its own
  // writes, so its executing rows are genuinely in-flight; a long-running but
  // LIVE adapter call (e.g. a GitHub call with withBackoff that exceeds the 30s
  // lease) is therefore never re-dispatched. Ownership is the gate; the lease is
  // a secondary signal that only applies to prior-generation rows.
  claimed_by: text("claimed_by"),
  // Durable supersession marker for the resume/requeue fallback pair. When a
  // mid_run `resume` probes unreachable and a fallback `requeue` is reserved, the
  // older `resume` reservation is marked superseded so crash recovery re-executes
  // ONLY the live requeue (never a stale mid_run wake AND a restart for the same
  // decision). Survives restart — it is the source of truth for the pair.
  superseded: boolean("superseded").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  created_at: text("created_at").notNull(),
  committed_at: text("committed_at"),
});

/** Durable §7 worker metadata so mid_run->requeue is implementable, not just fakeable. */
export const workerSessions = decisionIndex.table("worker_sessions", {
  decision_id: text("decision_id")
    .primaryKey()
    .references(() => decisions.decision_id),
  worker_session_id: text("worker_session_id"),
  transcript_path: text("transcript_path"),
  process_handle: text("process_handle"),
  stop_reason: text("stop_reason"),
  wake_command: text("wake_command"),
  work_request_ref: text("work_request_ref"),
  requeue_command: text("requeue_command"),
  last_heartbeat: text("last_heartbeat"),
  abandon_reason: text("abandon_reason"),
  resume_kind: text("resume_kind"),
});

/** Pointer table for the protected store. NO plaintext, NO plaintext hash. */
export const protectedRefs = decisionIndex.table("protected_refs", {
  ulid: text("ulid").primaryKey(),
  decision_id: text("decision_id"),
  field: text("field").notNull(),
  class: text("class").notNull(),
  created_at: text("created_at").notNull(),
});

/** Content-free rejected-ingestion log (fail-closed path, §5.1). */
export const quarantineEvents = decisionIndex.table("quarantine_events", {
  id: bigint("id", { mode: "number" })
    .primaryKey()
    .generatedAlwaysAsIdentity(),
  source_url: text("source_url"),
  source_event_id: text("source_event_id"),
  reason: text("reason").notNull(),
  // path NAMES only, never field values
  missing_paths: text("missing_paths"),
  created_at: text("created_at").notNull(),
});
