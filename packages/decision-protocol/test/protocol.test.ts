import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  AnswerSchemaSchema,
  PROTOCOL_VERSION,
  buildDecisionRequestJsonSchema,
} from "../src/index.js";

function validRequest(): unknown {
  return {
    decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://github.com/acme/repo/issues/12",
    source_etag: "etag-abc",
    source_event_id: "evt-1",
    deployment: "acme-platform",
    run_id: "run-42",
    worker_session_id: "ws-7",
    phase: "implementation",
    risk_class: "P1",
    question: "Proceed with the destructive migration?",
    context: "The migration drops the legacy column.",
    options: [
      { id: "yes", label: "Proceed", detail: "Run the migration now" },
      { id: "no", label: "Abort" },
    ],
    recommended_option: "no",
    consequence_of_no_answer: "Run stays paused.",
    reversibility: "hard_to_reverse",
    expires_at: "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: "mid_run",
    idempotency_key: "idem-1",
    trace_id: "trace-1",
    agent_version: "1.2.3",
    skill_version: "0.1.0",
  };
}

describe("PROTOCOL_VERSION", () => {
  it("is a semver string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("DecisionRequest round-trip", () => {
  it("parses a fully-valid request", () => {
    const parsed = DecisionRequestSchema.parse(validRequest());
    expect(parsed.decision_id).toBe("01HXYZABCDEFGHJKMNPQRSTVWX");
    expect(parsed.options).toHaveLength(2);
  });

  it("parses a request WITHOUT field_sensitivity (content-agnostic ingest)", () => {
    const req = validRequest() as Record<string, unknown>;
    const parsed = DecisionRequestSchema.parse(req);
    expect(parsed.decision_id).toBe("01HXYZABCDEFGHJKMNPQRSTVWX");
  });
});

describe("answer_schema discriminated union", () => {
  it("accepts kind=option", () => {
    expect(AnswerSchemaSchema.parse({ kind: "option" })).toEqual({ kind: "option" });
  });

  it("accepts kind=json with a schema", () => {
    const v = AnswerSchemaSchema.parse({ kind: "json", schema: { type: "object" } });
    expect(v.kind).toBe("json");
  });

  it("rejects an unknown kind", () => {
    expect(() => AnswerSchemaSchema.parse({ kind: "freeform" })).toThrow();
  });
});

describe("DecisionResponse", () => {
  it("parses a chosen_option response", () => {
    const r = DecisionResponseSchema.parse({
      decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      chosen_option: "no",
      answerer: "daniel",
      answered_at: "2026-05-27T10:00:00.000Z",
      idempotency_key: "idem-1",
    });
    expect(r.chosen_option).toBe("no");
  });

  it("parses a structured answer response", () => {
    const r = DecisionResponseSchema.parse({
      decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
      answer: { foo: "bar" },
      answerer: "daniel",
      answered_at: "2026-05-27T10:00:00.000Z",
      idempotency_key: "idem-2",
    });
    expect(r.answer).toEqual({ foo: "bar" });
  });

  it("REJECTS a payload carrying BOTH chosen_option and answer (XOR)", () => {
    expect(() =>
      DecisionResponseSchema.parse({
        decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
        chosen_option: "yes",
        answer: { foo: "bar" },
        answerer: "daniel",
        answered_at: "2026-05-27T10:00:00.000Z",
        idempotency_key: "idem-3",
      }),
    ).toThrow();
  });

  it("REJECTS a payload carrying NEITHER chosen_option nor answer", () => {
    expect(() =>
      DecisionResponseSchema.parse({
        decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
        answerer: "daniel",
        answered_at: "2026-05-27T10:00:00.000Z",
        idempotency_key: "idem-4",
      }),
    ).toThrow();
  });

  it("REJECTS unknown extra top-level fields (strictObject)", () => {
    expect(() =>
      DecisionResponseSchema.parse({
        decision_id: "01HXYZABCDEFGHJKMNPQRSTVWX",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: "2026-05-27T10:00:00.000Z",
        idempotency_key: "idem-5",
        injected: "surprise",
      }),
    ).toThrow();
  });
});

describe("committed JSON Schema matches freshly generated", () => {
  it("regenerate-and-diff", () => {
    const committedPath = fileURLToPath(
      new URL("../schema/decision-request.schema.json", import.meta.url),
    );
    const committed = JSON.parse(readFileSync(committedPath, "utf8"));
    const fresh = buildDecisionRequestJsonSchema();
    expect(committed).toEqual(fresh);
  });
});
