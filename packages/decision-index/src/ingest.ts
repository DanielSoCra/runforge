import { DecisionRequestSchema, PROTOCOL_VERSION, type DecisionRequest } from "@runforge/decision-protocol";
import type { Db } from "./db.js";
import type { Quarantine } from "./quarantine.js";
import { decisions } from "./schema.js";

export class NotAdmittedError extends Error {
  readonly missingPaths: string[];
  constructor(message: string, missingPaths: string[]) {
    super(message);
    this.name = "NotAdmittedError";
    this.missingPaths = missingPaths;
  }
}

export interface IngestDeps {
  db: Db;
  quarantine: Quarantine;
  clock?: () => Date;
}

export type DecisionRow = typeof decisions.$inferInsert;

/**
 * Content-agnostic ingestion. In memory, BEFORE any SQLite decisions write:
 *  1. parse -> on failure quarantine (content-free) + throw NotAdmittedError.
 *  2. protocol-version guard -> mismatch quarantines content-free and throws.
 *  3. return the DecisionRow built VERBATIM from the parsed request.
 *
 * Redaction/sanitization is intentionally NOT performed here. Future confidentiality
 * enforcement is config-driven via the sanitization pipeline (ARCH-AC-SANITIZATION),
 * selected per deployment; core ingest remains content-agnostic.
 */
export async function ingest(
  rawRequest: unknown,
  deps: IngestDeps,
): Promise<{ decisionRow: DecisionRow; request: DecisionRequest }> {
  const clock = deps.clock ?? (() => new Date());

  // Parse syntactically. A parse failure is a fail-closed quarantine.
  const parsed = DecisionRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    // Parse failure: source_url/source_event_id are operational and passed plainly.
    const raw = rawRequest as Record<string, unknown>;
    await deps.quarantine.record({
      source_url: typeof raw.source_url === "string" ? raw.source_url : undefined,
      source_event_id: typeof raw.source_event_id === "string" ? raw.source_event_id : undefined,
      reason: "schema_invalid",
      missingPaths: parsed.error.issues.map((i) => i.path.join(".")),
    });
    throw new NotAdmittedError("DecisionRequest failed schema validation", []);
  }
  const request = parsed.data;

  // PROTOCOL-VERSION GUARD (verdict fix_before_flag_on / decision-request.ts:35).
  // The schema admits ANY non-empty `protocol_version` (z.string().min(1)) so a
  // mis-versioned producer would be stored under the wrong contract. We enforce
  // equality HERE rather than via z.literal() in the schema: the committed
  // DecisionRequest JSON-Schema artifact is byte-pinned (regenerate-and-diff
  // test) and shared field-for-field with pm-cockpit, so tightening the zod type
  // would fork that artifact. An OMITTED version still defaults to
  // PROTOCOL_VERSION (the daemon's own build-request path omits it) and passes.
  // A concrete mismatch is QUARANTINED content-free (the version string is
  // operational, never PHI) and NOT admitted — drift is surfaced, not absorbed.
  if (request.protocol_version !== PROTOCOL_VERSION) {
    await deps.quarantine.record({
      decision_id: request.decision_id,
      source_url: request.source_url,
      source_event_id: request.source_event_id,
      reason: "protocol_version_mismatch",
      // path NAMES only; the actual version value is operational but we keep the
      // quarantine record minimal/content-free per the §5.1 contract.
      missingPaths: ["protocol_version"],
    });
    throw new NotAdmittedError(
      `DecisionRequest protocol_version mismatch (expected ${PROTOCOL_VERSION}); quarantined`,
      ["protocol_version"],
    );
  }

  const now = clock().toISOString();
  const decisionRow: DecisionRow = {
    decision_id: request.decision_id,
    protocol_version: request.protocol_version,
    status: "detected",
    source_url: request.source_url,
    source_etag: request.source_etag ?? null,
    source_event_id: request.source_event_id ?? null,
    deployment: request.deployment,
    run_id: request.run_id,
    worker_session_id: request.worker_session_id ?? null,
    phase: request.phase ?? null,
    risk_class: request.risk_class,
    question: request.question,
    context: request.context,
    options_json: JSON.stringify(request.options),
    recommended_option: request.recommended_option ?? null,
    consequence_of_no_answer: request.consequence_of_no_answer,
    reversibility: request.reversibility,
    answer_schema_json: JSON.stringify(request.answer_schema),
    resume_mode: request.resume_mode,
    idempotency_key: request.idempotency_key,
    trace_id: request.trace_id ?? null,
    agent_version: request.agent_version ?? null,
    skill_version: request.skill_version ?? null,
    expires_at: request.expires_at,
    last_seen_at: now,
    last_notified_at: null,
    stale: false,
    superseded_by: null,
    pinned: false,
    muted: false,
    deferred_until: null,
    created_at: now,
    updated_at: now,
  };

  return { decisionRow, request };
}
