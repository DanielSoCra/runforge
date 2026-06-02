import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  AnswerSchemaSchema,
  PROTOCOL_VERSION,
  SENSITIVITY_FIELD_PATHS,
  OPERATIONAL_FIELD_PATHS,
  REDACTABLE_FIELD_PATHS,
  assertFullyClassified,
  IncompleteClassificationError,
  sensitivityRank,
  allowedSinks,
  buildDecisionRequestJsonSchema,
} from "../src/index.js";

/**
 * A fully-valid, fully-classified DecisionRequest used as the base for mutation.
 * `field_sensitivity` must contain every canonical path including nested ones.
 */
function fullClassification(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) {
    map[p] = "internal";
  }
  return map;
}

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
    field_sensitivity: fullClassification(),
  };
}

describe("PROTOCOL_VERSION", () => {
  it("is a semver string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("DecisionRequest round-trip", () => {
  it("parses a fully-valid, fully-classified request", () => {
    const parsed = DecisionRequestSchema.parse(validRequest());
    expect(parsed.decision_id).toBe("01HXYZABCDEFGHJKMNPQRSTVWX");
    expect(parsed.options).toHaveLength(2);
    expect(() => assertFullyClassified(parsed)).not.toThrow();
  });
});

describe("sensitivity ordering + sinks", () => {
  it("orders public < internal < phi < secret", () => {
    expect(sensitivityRank("public")).toBeLessThan(sensitivityRank("internal"));
    expect(sensitivityRank("internal")).toBeLessThan(sensitivityRank("phi"));
    expect(sensitivityRank("phi")).toBeLessThan(sensitivityRank("secret"));
  });

  it("routes phi/secret to protected store only", () => {
    expect(allowedSinks("public")).toContain("all");
    expect(allowedSinks("internal")).toContain("all");
    expect(allowedSinks("phi")).toEqual(["protected"]);
    expect(allowedSinks("secret")).toEqual(["protected"]);
  });
});

describe("assertFullyClassified (fail-closed)", () => {
  it("throws with the missing TOP-LEVEL path", () => {
    const req = validRequest() as any;
    delete req.field_sensitivity["question"];
    const parsed = DecisionRequestSchema.parse(req);
    try {
      assertFullyClassified(parsed);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteClassificationError);
      expect((e as IncompleteClassificationError).missingPaths).toContain("question");
    }
  });

  it("throws with the missing NESTED options[].label path", () => {
    const req = validRequest() as any;
    delete req.field_sensitivity["options[].label"];
    const parsed = DecisionRequestSchema.parse(req);
    try {
      assertFullyClassified(parsed);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteClassificationError);
      expect((e as IncompleteClassificationError).missingPaths).toContain("options[].label");
    }
  });

  it("a partial map is invalid even if other paths are present", () => {
    const req = validRequest() as any;
    req.field_sensitivity = { decision_id: "internal" };
    const parsed = DecisionRequestSchema.parse(req);
    expect(() => assertFullyClassified(parsed)).toThrow(IncompleteClassificationError);
  });
});

describe("source_url is operational (A8/C4)", () => {
  it("source_url is in OPERATIONAL_FIELD_PATHS (never redactable)", () => {
    expect(OPERATIONAL_FIELD_PATHS).toContain("source_url");
  });
  it("source_url is NOT in REDACTABLE_FIELD_PATHS", () => {
    expect(REDACTABLE_FIELD_PATHS).not.toContain("source_url");
  });
});

describe("deployment is operational (CRITICAL 1)", () => {
  // The read model + dashboard render `deployment` as a plain queryable string
  // (filter dropdown / card / detail). If it were ever classified phi/secret it
  // would become a `protected://<ulid>` ref rendered as a plaintext token (or
  // break the filter). So like source_url it must be an OPERATIONAL field —
  // classifying it phi/secret is rejected at ingest, never redacted.
  it("deployment is in OPERATIONAL_FIELD_PATHS (never redactable)", () => {
    expect(OPERATIONAL_FIELD_PATHS).toContain("deployment");
  });
  it("deployment is NOT in REDACTABLE_FIELD_PATHS", () => {
    expect(REDACTABLE_FIELD_PATHS).not.toContain("deployment");
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
