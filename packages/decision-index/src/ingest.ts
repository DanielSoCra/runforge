import {
  DecisionRequestSchema,
  PROTOCOL_VERSION,
  assertFullyClassified,
  IncompleteClassificationError,
  isProtected,
  OPERATIONAL_FIELD_PATHS,
  type DecisionRequest,
  type SensitivityClass,
} from "@auto-claude/decision-protocol";
import type { Db } from "./db.js";
import type { ProtectedStore } from "./protected-store.js";
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
  protectedStore: ProtectedStore;
  quarantine: Quarantine;
  clock?: () => Date;
}

export type DecisionRow = typeof decisions.$inferInsert;

/**
 * Fail-closed ingestion (§5.1). In memory, BEFORE any SQLite decisions write:
 *  1. parse + assertFullyClassified -> on failure quarantine (content-free) + throw
 *     NotAdmittedError (item NOT admitted).
 *  2. for each phi/secret path, encrypt the value into the protected store and
 *     replace it with a protected:// ref.
 *  3. return the redacted DecisionRow for the caller's `detected` insert.
 *
 * NOTE: step 2 writes protected_refs rows, but never the decisions row — the
 * caller (IndexWriter.admit) inserts that. No plaintext ever reaches decisions.
 */
export function ingest(
  rawRequest: unknown,
  deps: IngestDeps,
): { decisionRow: DecisionRow; request: DecisionRequest } {
  const clock = deps.clock ?? (() => new Date());

  // Parse syntactically. A parse failure is also a fail-closed quarantine.
  const parsed = DecisionRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    // CRITICAL C2: a parse failure has NO trustworthy classification map, so we
    // cannot know whether source_url/source_event_id are phi/secret — the
    // quarantine record stays content-free (path NAMES only, never raw values).
    deps.quarantine.record({
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
    deps.quarantine.record({
      decision_id: request.decision_id,
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

  const fs = request.field_sensitivity as Record<string, SensitivityClass>;

  // CRITICAL C2: the quarantine path must be CONTENT-FREE. source_url /
  // source_event_id are themselves redactable request fields (field-paths.ts);
  // when classified phi/secret their plaintext must NEVER reach quarantine_events
  // (plaintext in SQLite). Forward them ONLY when non-sensitive; otherwise store
  // a redacted placeholder so the record stays informative without leaking.
  const quarantineId = (field: "source_url" | "source_event_id", value: string | null | undefined): string | undefined => {
    if (value === null || value === undefined) return undefined;
    const cls = fs?.[field];
    // Fail-closed: forward the RAW value ONLY when the field is EXPLICITLY
    // classified public/internal. If the class is phi/secret OR missing/undefined
    // (unknown classification), emit a redacted placeholder — never the raw value.
    if (cls === "public" || cls === "internal") return value;
    return `[redacted:${cls ?? "unknown"}]`;
  };

  // Completeness gate. (Runs AFTER fs is bound so the quarantine record can
  // redact any sensitive source_url/source_event_id even on an incomplete map.)
  try {
    assertFullyClassified(request);
  } catch (e) {
    if (e instanceof IncompleteClassificationError) {
      deps.quarantine.record({
        decision_id: request.decision_id,
        source_url: quarantineId("source_url", request.source_url),
        source_event_id: quarantineId("source_event_id", request.source_event_id),
        reason: "incomplete_classification",
        missingPaths: e.missingPaths, // path NAMES only
      });
      throw new NotAdmittedError(
        "DecisionRequest not fully classified; quarantined",
        e.missingPaths,
      );
    }
    throw e;
  }

  // CRITICAL 2 (fail-closed): an OPERATIONAL field (PK / id / queryable key /
  // structural element) classified phi/secret cannot be replaced with a
  // protected:// ref without breaking core logic. Storing its plaintext would
  // leak; so we FAIL admission to quarantine instead — never silently store it.
  const sensitiveOperational = OPERATIONAL_FIELD_PATHS.filter((p) => {
    const cls = fs[p];
    return cls !== undefined && isProtected(cls);
  });
  if (sensitiveOperational.length > 0) {
    deps.quarantine.record({
      decision_id: request.decision_id,
      source_url: quarantineId("source_url", request.source_url),
      source_event_id: quarantineId("source_event_id", request.source_event_id),
      reason: "operational_field_sensitive",
      missingPaths: sensitiveOperational, // path NAMES only, never values
    });
    throw new NotAdmittedError(
      `operational field(s) classified phi/secret cannot be protected without breaking logic; quarantined: ${sensitiveOperational.join(", ")}`,
      sensitiveOperational,
    );
  }

  const redact = (field: string, value: string): string => {
    const cls = fs[field];
    if (cls && isProtected(cls)) {
      return deps.protectedStore.put({
        decision_id: request.decision_id,
        field,
        class: cls,
        plaintext: value,
      });
    }
    return value;
  };

  // Redact a nullable/optional field only when a value is present.
  const redactOpt = (field: string, value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return value ?? null;
    return redact(field, value);
  };

  // Redact top-level content + observability fields. Every REDACTABLE classified
  // phi/secret path is protected here (Finding 2: not only question/context).
  const question = redact("question", request.question);
  const context = redact("context", request.context);
  const consequence = redact("consequence_of_no_answer", request.consequence_of_no_answer);
  // C4/A8: source_url is OPERATIONAL (the freshness probe + comment post address
  // the source by it), so it is NEVER redacted — a phi/secret classification on
  // it already fail-closed to quarantine above. Preserve the plaintext locator.
  const sourceUrl = request.source_url;
  const sourceEventId = redactOpt("source_event_id", request.source_event_id);
  // CRITICAL 1: deployment is OPERATIONAL (the dashboard's queryable filter key
  // rendered on the dropdown/card/detail), so it is NEVER redacted — a phi/secret
  // classification on it already fail-closed to quarantine above. Preserve plaintext.
  const deployment = request.deployment;
  const workerSessionId = redactOpt("worker_session_id", request.worker_session_id);
  const phase = redactOpt("phase", request.phase);
  const traceId = redactOpt("trace_id", request.trace_id);
  const agentVersion = redactOpt("agent_version", request.agent_version);
  const skillVersion = redactOpt("skill_version", request.skill_version);

  // Redact nested option leaves. The classification is per-shape
  // (options[].label etc.); apply it to every element. NOTE: options[].id is an
  // OPERATIONAL field (matched against the answerer's chosen_option), so a
  // phi/secret classification on it already fail-closed to quarantine above —
  // it is never redacted-in-place here; the plaintext id is preserved.
  const optClsLabel = fs["options[].label"];
  const optClsDetail = fs["options[].detail"];
  const redactedOptions = request.options.map((o, idx) => ({
    id: o.id,
    label: optClsLabel && isProtected(optClsLabel)
      ? deps.protectedStore.put({
          decision_id: request.decision_id,
          field: `options[${idx}].label`,
          class: optClsLabel,
          plaintext: o.label,
        })
      : o.label,
    ...(o.detail !== undefined
      ? {
          detail:
            optClsDetail && isProtected(optClsDetail)
              ? deps.protectedStore.put({
                  decision_id: request.decision_id,
                  field: `options[${idx}].detail`,
                  class: optClsDetail,
                  plaintext: o.detail,
                })
              : o.detail,
        }
      : {}),
  }));

  const now = clock().toISOString();
  const decisionRow: DecisionRow = {
    decision_id: request.decision_id,
    protocol_version: request.protocol_version,
    status: "detected",
    source_url: sourceUrl,
    source_etag: request.source_etag ?? null,
    source_event_id: sourceEventId,
    deployment,
    run_id: request.run_id,
    worker_session_id: workerSessionId,
    phase,
    risk_class: request.risk_class,
    question,
    context,
    options_json: JSON.stringify(redactedOptions),
    recommended_option: request.recommended_option ?? null,
    consequence_of_no_answer: consequence,
    reversibility: request.reversibility,
    answer_schema_json: JSON.stringify(request.answer_schema),
    resume_mode: request.resume_mode,
    idempotency_key: request.idempotency_key,
    trace_id: traceId,
    agent_version: agentVersion,
    skill_version: skillVersion,
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
