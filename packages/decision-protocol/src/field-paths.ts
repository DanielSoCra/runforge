/**
 * Canonical, exhaustive list of every content-bearing leaf path of a DecisionRequest.
 * The fail-closed ingestion gate (assertFullyClassified) requires the request's
 * `field_sensitivity` map to classify EVERY one of these — nested array element
 * paths (e.g. `options[].label`) included.
 *
 * `field_sensitivity` itself is metadata and is intentionally NOT in this list.
 */
export const SENSITIVITY_FIELD_PATHS: string[] = [
  "decision_id",
  "protocol_version",
  "source_url",
  "source_etag",
  "source_event_id",
  "deployment",
  "run_id",
  "worker_session_id",
  "phase",
  "risk_class",
  "question",
  "context",
  // nested option element leaves — classified per-shape, not per-instance
  "options[].id",
  "options[].label",
  "options[].detail",
  "recommended_option",
  "consequence_of_no_answer",
  "reversibility",
  "expires_at",
  "answer_schema",
  "resume_mode",
  "idempotency_key",
  "trace_id",
  "agent_version",
  "skill_version",
];

/**
 * Operational fields whose VALUE the index depends on as a queryable key / id /
 * structural element — they cannot be replaced with a `protected://<ulid>` ref
 * without breaking core logic (PK joins, deterministic effect-id semantic keys,
 * option-id matching, answer-schema parsing, etc.). If any of these is
 * classified `phi`/`secret`, the request is FAIL-CLOSED to quarantine rather
 * than stored in plaintext (§5.1, fail-closed > silent plaintext leak).
 *
 * Rationale per field:
 *  - decision_id        — PK; the cross-system stable join key (decisions,
 *                         decision_responses, applied_transitions, protected_refs…).
 *  - source_url         — operational source LOCATOR (issue url / node id). The
 *                         freshness guard (currentEtag(sourceLocator)) and the
 *                         answer-comment post both address the source by it; a
 *                         redacted ref would break both (C4). NEVER redactable.
 *  - deployment         — operational FILTER KEY. The read model returns it as a
 *                         plain string and the dashboard queries/renders it on the
 *                         filter dropdown + card + detail. A `protected://<ulid>`
 *                         ref would render as a plaintext token and break the
 *                         filter, so a phi/secret class fail-closes (CRITICAL 1).
 *  - run_id             — semantic key for resume/requeue deterministic effect
 *                         ids and the live-worker address; must be the real value.
 *  - options[].id /
 *    recommended_option — matched against the answerer's plaintext chosen_option.
 *  - answer_schema      — parsed as JSON to validate structured answers.
 *  - protocol_version /
 *    resume_mode /
 *    risk_class /
 *    reversibility /
 *    expires_at /
 *    idempotency_key /
 *    source_etag        — drive state/branch decisions, the source-write
 *                         precondition, expiry, and idempotency; queried as-is.
 */
export const OPERATIONAL_FIELD_PATHS: readonly string[] = [
  "decision_id",
  "protocol_version",
  "source_url",
  "deployment",
  "run_id",
  "risk_class",
  "options[].id",
  "recommended_option",
  "reversibility",
  "expires_at",
  "answer_schema",
  "resume_mode",
  "idempotency_key",
  "source_etag",
];

/**
 * Content-bearing free-text/observability fields that MAY be redacted to a
 * `protected://<ulid>` ref when classified phi/secret — the index stores the
 * ref string and never depends on the underlying value for logic.
 */
export const REDACTABLE_FIELD_PATHS: readonly string[] = SENSITIVITY_FIELD_PATHS.filter(
  (p) => !OPERATIONAL_FIELD_PATHS.includes(p),
);
