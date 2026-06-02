import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { apply } from "../src/state-machine.js";
import { decisionResponses, auditLog, decisions } from "../src/schema.js";
import { eq } from "drizzle-orm";

const NOW = "2026-05-27T01:00:00.000Z";

function toViewed(db: TempDb["db"], id: string) {
  apply(db, id, "notify", { semanticKey: "slack", now: NOW });
  apply(db, id, "opened", { semanticKey: "daniel", now: NOW });
}

describe("answer-schema validation (synchronous, pure)", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("option not in options[] -> rejected, stays viewed, no response row", () => {
    const id = seedDecision(t.db);
    toViewed(t.db, id);
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "maybe", // not in [yes,no]
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/not in options/);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("viewed");
  });

  it("json answer failing answer_schema -> rejected", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({
        kind: "json",
        schema: { type: "object", required: ["amount"] },
      }),
    });
    toViewed(t.db, id);
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        answer_value: { note: "no amount" },
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/required/);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
  });

  it("Finding 7: json answer with a WRONG-TYPED property is rejected (full JSON Schema validation, not just required[])", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({
        kind: "json",
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "number", minimum: 0 } },
          additionalProperties: false,
        },
      }),
    });
    toViewed(t.db, id);
    // amount present but a string, not a number -> the OLD impl (top-level
    // required-only) accepted this; full schema validation rejects it.
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        answer_value: { amount: "not-a-number" },
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/schema/);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(0);
  });

  it("Finding 7: json answer violating a numeric constraint (minimum) is rejected", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({
        kind: "json",
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "number", minimum: 0 } },
        },
      }),
    });
    toViewed(t.db, id);
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        answer_value: { amount: -5 },
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(false);
    expect(r.rejected?.reason).toMatch(/schema/);
  });

  it("Finding 7: a well-typed json answer is accepted", () => {
    const id = seedDecision(t.db, {
      answer_schema_json: JSON.stringify({
        kind: "json",
        schema: {
          type: "object",
          required: ["amount"],
          properties: { amount: { type: "number", minimum: 0 } },
        },
      }),
    });
    toViewed(t.db, id);
    const r = apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        answer_value: { amount: 42 },
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(t.db.select().from(decisionResponses).all()).toHaveLength(1);
  });

  it("accepted answer records answering + validated audit sub-steps, no durable answering/validated status", () => {
    const id = seedDecision(t.db);
    toViewed(t.db, id);
    apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    const events = t.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision_id === id)
      .map((a) => a.event);
    expect(events).toContain("answering");
    expect(events).toContain("validated");
    expect(events).toContain("answer_submitted");

    // no row ever has a durable answering/validated status
    const statuses = t.db
      .select({ status: decisions.status })
      .from(decisions)
      .where(eq(decisions.decision_id, id))
      .all()
      .map((r) => r.status);
    expect(statuses).toEqual(["answered_pending_source_write"]);
  });
});
