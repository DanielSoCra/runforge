import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import AjvModule, { type ValidateFunction } from "ajv";
import { TERMINAL_STATUSES } from "@auto-claude/decision-protocol";

// ajv 8 ships a CJS `module.exports = Ajv` plus a `.default`; under NodeNext the
// default import resolves to the namespace, so unwrap `.default` (the actual
// constructable class) when present.
type AjvCtor = typeof AjvModule.default;
const Ajv: AjvCtor =
  (AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor);
import type { TransitionEvent, ItemStatus, EffectKind } from "@auto-claude/decision-protocol";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { decisions, decisionResponses, appliedTransitions, outbox } from "./schema.js";
import { transition, type TransitionItem, type TransitionResult } from "./transition-table.js";
import { transitionKey } from "./idempotency.js";
import { appendAudit } from "./audit-log.js";

export class AnswerRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`answer rejected: ${reason}`);
    this.name = "AnswerRejectedError";
    this.reason = reason;
  }
}

export class AnsweredOnceConflictError extends Error {
  constructor(decisionId: string) {
    super(`decision ${decisionId} already answered with a different response`);
    this.name = "AnsweredOnceConflictError";
  }
}

export class UnknownDecisionError extends Error {
  constructor(decisionId: string) {
    super(`unknown decision ${decisionId}`);
    this.name = "UnknownDecisionError";
  }
}

export interface AnswerPayload {
  response_idempotency_key: string;
  chosen_option?: string;
  /** structured answer (already redacted: protected ref or non-sensitive value). */
  answer_ref?: string;
  answer_value?: unknown;
  /**
   * Sensitivity of a structured (json) answer. When `phi`/`secret`, the caller
   * MUST supply `answer_ref` (a protected:// ref) and MUST NOT supply
   * `answer_value` — the plaintext value is never stored, and the response_hash
   * is computed over the ref via a keyed HMAC (Finding 3). A sensitive answer
   * with a raw `answer_value` is rejected.
   */
  answer_sensitivity?: "public" | "internal" | "phi" | "secret";
  /**
   * Finding I7: the PLAINTEXT structured value, carried ONLY for in-memory Ajv
   * validation when a sensitive answer has already been redacted to `answer_ref`.
   * It is validated against answer_schema but is NEVER stored or hashed — the
   * writer sets it so an invalid PHI/secret JSON answer is still rejected.
   */
  validate_value?: unknown;
  answerer: string;
  answered_at: string;
}

export interface ApplyCtx {
  /** transition semantic key (channel/viewer/run_id/etag/...). */
  semanticKey: string;
  actor?: string;
  trace_id?: string;
  now: string;
  /** for answer_submitted. */
  answer?: AnswerPayload;
  /** for source_superseded / precondition_failed. */
  superseded_by?: string;
  /**
   * Keyed-HMAC response hasher (Finding 3). When provided, the answered-once
   * `response_hash` is a keyed HMAC over the canonical (already-redacted) payload
   * rather than a bare SHA-256 of plaintext — a low-entropy PHI/secret answer
   * never yields a guessable plaintext-derived hash in SQLite. REQUIRED when an
   * answer is sensitive; the writer always injects it.
   */
  responseHash?: (canonical: string) => string;
}

export interface ApplyResult {
  applied: boolean; // false => idempotent no-op (already applied)
  status: ItemStatus;
  effects: EffectKind[];
  rejected?: { reason: string };
}

interface DecisionStateRow {
  decision_id: string;
  status: ItemStatus;
  stale: boolean;
  resume_mode: "mid_run" | "requeue";
  answer_schema_json: string;
  options_json: string;
  trace_id: string | null;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/**
 * Hash the canonical payload.
 *
 * Finding 3 / C3: a SENSITIVE (phi/secret) answer MUST use the injected
 * keyed-HMAC hasher — there is NO SHA-over-plaintext fallback for it. If a
 * caller omits the hasher for a sensitive answer we reject (throw
 * AnswerRejectedError) rather than silently producing a guessable
 * plaintext-derived (bare SHA-256) hash. The SHA-256 fallback survives ONLY for
 * the non-sensitive bare-API path, where the canonical payload carries no
 * PHI/secret material.
 */
function hashPayload(
  payload: unknown,
  hashFn: ((canonical: string) => string) | undefined,
  sensitive: boolean,
): string {
  const canonical = canonicalize(payload);
  if (hashFn) return hashFn(canonical);
  if (sensitive) {
    throw new AnswerRejectedError(
      "sensitive (phi/secret) answer requires a keyed-HMAC response hasher; refusing plaintext-derived hash",
    );
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * C1 — derive the REDACTED, non-sensitive payload the sink may post back. A
 * phi/secret answer yields `null` (only the answer_ref is stored; the sink posts
 * an acknowledgement, never plaintext). A non-sensitive option answer yields the
 * chosen_option id; a non-sensitive json answer yields the JSON value as a string.
 * NEVER includes phi/secret material — this is the byte-scan invariant.
 */
export function postableResponsePayload(answer: AnswerPayload): string | null {
  const sensitive = answer.answer_sensitivity === "phi" || answer.answer_sensitivity === "secret";
  if (sensitive) return null;
  if (answer.chosen_option !== undefined) {
    return JSON.stringify({ chosen_option: answer.chosen_option });
  }
  if (answer.answer_value !== undefined) {
    return JSON.stringify({ answer_value: answer.answer_value });
  }
  return null;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();
function compile(schema: Record<string, unknown>, cacheKey: string): ValidateFunction {
  let v = validatorCache.get(cacheKey);
  if (!v) {
    v = ajv.compile(schema);
    validatorCache.set(cacheKey, v);
  }
  return v;
}

/**
 * Validate an answer against the request's answer_schema (synchronous, pure).
 * Returns the canonical response hash on success. Throws AnswerRejectedError on
 * invalid answers (caller leaves the item in `viewed`, writes no response row).
 *
 * For `kind:json`, the stored JSON Schema is validated with Ajv (Finding 7 —
 * full type/constraint validation, not just top-level required[] presence).
 * The response_hash is computed over the REDACTED payload via the injected
 * keyed-HMAC hasher (Finding 3); a sensitive answer must arrive as `answer_ref`
 * (no raw `answer_value`).
 */
export function validateAnswer(
  row: { answer_schema_json: string; options_json: string },
  answer: AnswerPayload,
  hashFn?: (canonical: string) => string,
): { responseHash: string } {
  const schema = JSON.parse(row.answer_schema_json) as
    | { kind: "option" }
    | { kind: "json"; schema: Record<string, unknown> };

  const sensitive = answer.answer_sensitivity === "phi" || answer.answer_sensitivity === "secret";

  if (schema.kind === "option") {
    if (answer.chosen_option === undefined) {
      throw new AnswerRejectedError("option answer requires chosen_option");
    }
    const options = JSON.parse(row.options_json) as { id: string }[];
    if (!options.some((o) => o.id === answer.chosen_option)) {
      throw new AnswerRejectedError(`chosen_option '${answer.chosen_option}' not in options[]`);
    }
    return { responseHash: hashPayload({ chosen_option: answer.chosen_option }, hashFn, sensitive) };
  }

  // kind === "json".
  if (answer.answer_value === undefined && answer.answer_ref === undefined) {
    throw new AnswerRejectedError("json answer requires answer_value or answer_ref");
  }

  // Finding 3: a sensitive structured answer must be redacted to a ref BEFORE it
  // reaches here — never validate/store raw sensitive plaintext, never hash it.
  if (sensitive && answer.answer_value !== undefined) {
    throw new AnswerRejectedError(
      "sensitive (phi/secret) answer must be supplied as answer_ref, not raw answer_value",
    );
  }

  // Finding I7: validate the plaintext JSON value via Ajv (types + constraints,
  // not just top-level required presence). For a non-sensitive answer the value
  // is in `answer_value`; for a sensitive answer the writer redacted it to
  // `answer_ref` but passes the plaintext in `validate_value` for THIS check
  // (never stored, never hashed) so an invalid PHI/secret answer is still
  // rejected before redaction is committed.
  //
  // Residual I7 (fail-closed): a SENSITIVE json answer arrives only as
  // `answer_ref` (raw `answer_value` is forbidden above). It MUST carry a
  // `validate_value` so Ajv can run — otherwise an unvalidated sensitive answer
  // would be HMACed + persisted. Defensively REQUIRE it here: if a sensitive
  // json answer has no `validate_value`, reject rather than skip validation.
  if (sensitive && answer.validate_value === undefined) {
    throw new AnswerRejectedError(
      "sensitive (phi/secret) json answer requires validate_value for schema validation; refusing unvalidated answer",
    );
  }
  const toValidate = answer.answer_value !== undefined ? answer.answer_value : answer.validate_value;
  if (toValidate !== undefined) {
    const validate = compile(schema.schema, row.answer_schema_json);
    if (!validate(toValidate)) {
      const msg = ajv.errorsText(validate.errors, { dataVar: "answer" });
      throw new AnswerRejectedError(`json answer failed schema: ${msg}`);
    }
  }

  // Hash over the redacted payload only (ref + non-sensitive value). For a
  // sensitive answer, only the ref is present, so no plaintext is hashed.
  return {
    responseHash: hashPayload(
      {
        answer_ref: answer.answer_ref ?? null,
        answer_value: sensitive ? null : answer.answer_value ?? null,
      },
      hashFn,
      sensitive,
    ),
  };
}

function loadState(db: Db, decisionId: string): DecisionStateRow {
  const rows = db
    .select({
      decision_id: decisions.decision_id,
      status: decisions.status,
      stale: decisions.stale,
      resume_mode: decisions.resume_mode,
      answer_schema_json: decisions.answer_schema_json,
      options_json: decisions.options_json,
      trace_id: decisions.trace_id,
    })
    .from(decisions)
    .where(eq(decisions.decision_id, decisionId))
    .all();
  const r = rows[0];
  if (!r) throw new UnknownDecisionError(decisionId);
  return {
    ...r,
    status: r.status as ItemStatus,
    resume_mode: r.resume_mode as "mid_run" | "requeue",
  };
}

/**
 * Apply one transition atomically (one SQLite txn):
 *  1. applied_transitions(decision_id, key) present  => no-op (idempotent replay)
 *  2. state guard via pure transition table (illegal => throw, no write)
 *  3. answer path: validate answer_schema (invalid => reject, stay `viewed`,
 *     NO decision_responses row, NO status change) -> guarded insert into
 *     decision_responses (same key+hash => replay no-op; conflict => reject) ->
 *     advance, recording audit rows for the answering/validated sub-steps.
 *  4. write status + applied_transitions + audit row.
 * External side-effects are NEVER run here (see outbox).
 */
export function apply(db: Db, decisionId: string, event: TransitionEvent, ctx: ApplyCtx): ApplyResult {
  return withTx(db, (tx) => {
    const state = loadState(tx, decisionId);
    const key = transitionKey(event, ctx.semanticKey);

    // (1) idempotent replay guard
    const already = tx
      .select()
      .from(appliedTransitions)
      .where(eq(appliedTransitions.transition_key, key))
      .all()
      .filter((r) => r.decision_id === decisionId);
    if (already.length > 0) {
      return { applied: false, status: state.status, effects: [] };
    }

    // (2a) DB-enforced answered-once guard runs BEFORE the state guard for the
    // answer path, so a second distinct answer that arrives after the item has
    // already advanced is rejected as a conflict (the invariant) rather than as
    // an illegal transition. A same-key+hash repeat is an idempotent no-op.
    if (event === "answer_submitted") {
      const a = ctx.answer;
      if (!a) throw new AnswerRejectedError("answer_submitted requires ctx.answer");
      const existing = tx
        .select()
        .from(decisionResponses)
        .where(eq(decisionResponses.decision_id, decisionId))
        .all();
      if (existing.length > 0) {
        const prev = existing[0]!;
        const sensitive =
          a.answer_sensitivity === "phi" || a.answer_sensitivity === "secret";
        const candidateHash =
          a.chosen_option !== undefined
            ? hashPayload({ chosen_option: a.chosen_option }, ctx.responseHash, sensitive)
            : hashPayload(
                {
                  answer_ref: a.answer_ref ?? null,
                  answer_value: sensitive ? null : a.answer_value ?? null,
                },
                ctx.responseHash,
                sensitive,
              );
        if (
          prev.response_idempotency_key === a.response_idempotency_key &&
          prev.response_hash === candidateHash
        ) {
          return { applied: false, status: state.status, effects: [] };
        }
        throw new AnsweredOnceConflictError(decisionId);
      }
    }

    // (2b) pure state guard
    const item: TransitionItem = {
      status: state.status,
      stale: state.stale,
      resume_mode: state.resume_mode,
    };
    const result: TransitionResult = transition(item, event, {
      superseded_by: ctx.superseded_by,
    });

    // (3) answer-path specifics
    if (event === "answer_submitted") {
      const answer = ctx.answer;
      if (!answer) throw new AnswerRejectedError("answer_submitted requires ctx.answer");

      // audit: answering sub-step (no durable status)
      appendAudit(tx, {
        decision_id: decisionId,
        from: state.status,
        to: state.status,
        event: "answering",
        transition_key: transitionKey("answering", answer.response_idempotency_key),
        actor: ctx.actor,
        at: ctx.now,
        trace_id: ctx.trace_id ?? state.trace_id,
      });

      // synchronous validation
      let responseHash: string;
      try {
        responseHash = validateAnswer(state, answer, ctx.responseHash).responseHash;
      } catch (e) {
        if (e instanceof AnswerRejectedError) {
          // reject: stay viewed, no response row, no status change, no applied_transitions.
          appendAudit(tx, {
            decision_id: decisionId,
            from: state.status,
            to: state.status,
            event: "answering",
            actor: ctx.actor,
            at: ctx.now,
            detail: { rejected: e.reason },
            trace_id: ctx.trace_id ?? state.trace_id,
          });
          return {
            applied: false,
            status: state.status,
            effects: [],
            rejected: { reason: e.reason },
          };
        }
        throw e;
      }

      // guarded answered-once insert (PK decision_id)
      const existing = tx
        .select()
        .from(decisionResponses)
        .where(eq(decisionResponses.decision_id, decisionId))
        .all();
      if (existing.length > 0) {
        const prev = existing[0]!;
        if (
          prev.response_idempotency_key === answer.response_idempotency_key &&
          prev.response_hash === responseHash
        ) {
          // same key + same payload => replay no-op
          return { applied: false, status: state.status, effects: [] };
        }
        // any second distinct answer => conflict
        throw new AnsweredOnceConflictError(decisionId);
      }
      tx.insert(decisionResponses)
        .values({
          decision_id: decisionId,
          response_idempotency_key: answer.response_idempotency_key,
          response_hash: responseHash,
          chosen_option: answer.chosen_option ?? null,
          answer_ref: answer.answer_ref ?? null,
          // C1: store the postable payload ONLY for a non-sensitive answer; a
          // phi/secret answer leaves this NULL (sink posts an ack, never plaintext).
          response_payload_json: postableResponsePayload(answer),
          answerer: answer.answerer,
          answered_at: answer.answered_at,
        })
        .run();

      // audit: validated sub-step (no durable status)
      appendAudit(tx, {
        decision_id: decisionId,
        from: state.status,
        to: state.status,
        event: "validated",
        transition_key: transitionKey("validated", answer.response_idempotency_key),
        actor: ctx.actor,
        at: ctx.now,
        trace_id: ctx.trace_id ?? state.trace_id,
      });
    }

    // (4) status advance + flags + applied_transitions + audit
    const updates: Record<string, unknown> = { status: result.next, updated_at: ctx.now };
    if (result.next === "superseded" && ctx.superseded_by) {
      updates.superseded_by = ctx.superseded_by;
    }
    if (result.setStale) updates.stale = true;
    // A9: the index owns `last_notified_at` (the Notifier interface has no DB
    // access). Set it in the SAME commit txn for a notify/re_notify transition so
    // the freshness/expiry logic + dashboard always see when we last pinged.
    if (event === "notify" || event === "re_notify") {
      updates.last_notified_at = ctx.now;
    }
    tx.update(decisions).set(updates).where(eq(decisions.decision_id, decisionId)).run();

    tx.insert(appliedTransitions)
      .values({ decision_id: decisionId, transition_key: key, applied_at: ctx.now })
      .run();

    // UNIFIED FIX (b) — cancel-on-terminal at the REAL chokepoint. The moment a
    // decision ADVANCES to a terminal status (resumed / superseded / failed),
    // cancel its outstanding non-committed outbox rows — regardless of WHICH path
    // advanced it. Wiring this into apply() (not only into Outbox's own
    // commit/markSuperseded/failItem) covers direct terminal events that bypass
    // the outbox entirely: applyEvent's resume_ack -> resumed and
    // source_superseded -> superseded. This makes the invariant "a terminal
    // transition leaves ZERO live reserved rows at transition time" hold
    // IMMEDIATELY, not only after a later reconcile. We reuse the durable
    // `superseded` boolean as the cancel marker so a reserved row can never be
    // re-executed/committed by a later reconcile against a terminal decision (even
    // across restart); committed rows record a real effect and are left untouched.
    // Idempotent + redundant-safe with the Outbox-path cancellation.
    if (TERMINAL_STATUSES.has(result.next)) {
      tx.update(outbox)
        .set({ superseded: true })
        .where(and(eq(outbox.decision_id, decisionId), ne(outbox.state, "committed")))
        .run();
    }

    appendAudit(tx, {
      decision_id: decisionId,
      from: state.status,
      to: result.next,
      event,
      transition_key: key,
      actor: ctx.actor,
      at: ctx.now,
      trace_id: ctx.trace_id ?? state.trace_id,
    });

    return { applied: true, status: result.next, effects: result.effects };
  });
}
