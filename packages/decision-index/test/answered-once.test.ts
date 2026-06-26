import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { apply, AnsweredOnceConflictError } from "../src/state-machine.js";
import { decisionResponses, appliedTransitions } from "../src/schema.js";

const NOW = "2026-05-27T01:00:00.000Z";

async function toViewed(db: PgliteTestDb["db"], id: string) {
  await apply(db, id, "notify", { semanticKey: "slack", now: NOW });
  await apply(db, id, "opened", { semanticKey: "daniel", now: NOW });
}

describe("answered-once (DB-enforced via decision_responses PK)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("first answer accepted, advances to answered_pending_source_write", async () => {
    const id = await seedDecision(t.db);
    await toViewed(t.db, id);
    const r = await apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    expect(r.applied).toBe(true);
    expect(r.status).toBe("answered_pending_source_write");
    expect(await t.db.select().from(decisionResponses)).toHaveLength(1);
  });

  it("second DISTINCT answer rejected; exactly one response row", async () => {
    const id = await seedDecision(t.db);
    await toViewed(t.db, id);
    await apply(t.db, id, "answer_submitted", {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    // a new distinct answer with a different key after acceptance -> conflict
    await expect(
      apply(t.db, id, "answer_submitted", {
        semanticKey: "resp-2",
        now: NOW,
        answer: {
          response_idempotency_key: "resp-2",
          chosen_option: "no",
          answerer: "daniel",
          answered_at: NOW,
        },
      }),
    ).rejects.toThrow(AnsweredOnceConflictError);
    expect(await t.db.select().from(decisionResponses)).toHaveLength(1);
  });

  it("replay of same (decision_id, transition_key) is a no-op; audit not double-written", async () => {
    const id = await seedDecision(t.db);
    await toViewed(t.db, id);
    const answerCtx = {
      semanticKey: "resp-1",
      now: NOW,
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    };
    await apply(t.db, id, "answer_submitted", answerCtx);
    const r2 = await apply(t.db, id, "answer_submitted", answerCtx);
    expect(r2.applied).toBe(false);
    // only one applied_transitions row for this key
    const keys = (await t.db.select().from(appliedTransitions)).filter(
      (x) => x.decision_id === id && x.transition_key === "answer_submitted:resp-1",
    );
    expect(keys).toHaveLength(1);
    expect(await t.db.select().from(decisionResponses)).toHaveLength(1);
  });

  it("PRODUCTION-CALLER conflict: same response_idempotency_key + same semanticKey, DIFFERENT chosen_option -> conflict, not a silent no-op", async () => {
    // The daemon ledger (ledger.ts:99,102) keys BOTH semanticKey and
    // response_idempotency_key on `${decisionId}:answer` — derived from
    // decision_id only, independent of chosen_option. So a second human answer
    // that flips the chosen_option arrives on the SAME transition_key. The
    // applied_transitions replay guard must NOT swallow it as `{applied:false}`;
    // a conflicting human decision must raise AnsweredOnceConflictError, not be
    // silently dropped (leaving an ambiguous ledger).
    const id = await seedDecision(t.db);
    await toViewed(t.db, id);
    const semanticKey = `${id}:answer`;
    await apply(t.db, id, "answer_submitted", {
      semanticKey,
      now: NOW,
      answer: {
        response_idempotency_key: semanticKey,
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    });
    await expect(
      apply(t.db, id, "answer_submitted", {
        semanticKey,
        now: NOW,
        answer: {
          response_idempotency_key: semanticKey,
          chosen_option: "no", // FLIPPED
          answerer: "daniel",
          answered_at: NOW,
        },
      }),
    ).rejects.toThrow(AnsweredOnceConflictError);
    // still exactly one response row; the conflict is surfaced, not absorbed.
    expect(await t.db.select().from(decisionResponses)).toHaveLength(1);
  });

  it("PRODUCTION-CALLER replay: same response_idempotency_key + same semanticKey + SAME chosen_option -> idempotent no-op", async () => {
    // The genuine retry case (same answer re-applied) must still dedup quietly.
    const id = await seedDecision(t.db);
    await toViewed(t.db, id);
    const semanticKey = `${id}:answer`;
    const answerCtx = {
      semanticKey,
      now: NOW,
      answer: {
        response_idempotency_key: semanticKey,
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: NOW,
      },
    };
    const r1 = await apply(t.db, id, "answer_submitted", answerCtx);
    expect(r1.applied).toBe(true);
    const r2 = await apply(t.db, id, "answer_submitted", answerCtx);
    expect(r2.applied).toBe(false);
    expect(await t.db.select().from(decisionResponses)).toHaveLength(1);
  });

  it("illegal transition rejected", async () => {
    const id = await seedDecision(t.db);
    // answer before viewed is illegal
    await expect(
      apply(t.db, id, "answer_submitted", {
        semanticKey: "resp-1",
        now: NOW,
        answer: {
          response_idempotency_key: "resp-1",
          chosen_option: "yes",
          answerer: "daniel",
          answered_at: NOW,
        },
      }),
    ).rejects.toThrow();
  });
});
