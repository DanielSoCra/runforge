import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable, workerSessions } from "../src/schema.js";

async function toSourceWritten(t: PgliteTestDb, f: ReturnType<typeof makeOutbox>, id: string) {
  await answerItem(t, f.outbox, id);
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

/**
 * FINDING 2 — the sweep re-drives by `decision_id` and re-derives the effect from
 * STATE, missing the ACTUAL pending row.
 *
 * After a mid_run resume goes `unreachable`, the outbox falls back to a `requeue`
 * (the live recovery effect) and marks the older `resume` reservation superseded.
 * If that fallback requeue then fails TRANSIENTLY, the live pending row is a
 * RESERVED `requeue`. A state-derived sweep, however, derives `resume` for a
 * `source_written` + `resume_mode=mid_run` item and calls `runEffect(id,'resume')`
 * — which hits the SUPERSEDED resume row, returns `unchanged`, and NEVER retries
 * the reserved requeue. The decision is STRANDED (stuck until restart).
 *
 * Also (outbox fallback): the superseded resume row must be RELEASED/settled, not
 * left `executing` — a leftover `executing` row worsens recovery.
 *
 * FIX (a): `pendingEffectDecisions()` returns the ACTUAL pending (decision_id,
 * kind); the sweep re-drives THAT kind via `runEffect(decision_id, kind)`, so a
 * reserved `requeue` is retried AS requeue. FIX (b): the fallback releases the
 * superseded resume row's claim so it is not left `executing`.
 */
describe("FINDING 2 — sweep re-drives the ACTUAL pending row kind (reserved requeue retried as requeue)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("a transient requeue failure leaves a reserved `requeue`; the superseded resume row is NOT left `executing`, and pendingEffectDecisions reports the requeue kind", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    const resumeId = await f.outbox.effectIdFor(id, "resume");
    const requeueId = await f.outbox.effectIdFor(id, "requeue");

    // mid_run resume probes unreachable -> fallback requeue; the requeue dispatch
    // then fails TRANSIENTLY (one failure, attempts < max -> reserved retryable).
    f.resumeDispatcher.results = ["unreachable", "failed"];
    const r = await f.outbox.runEffect(id, "resume");
    expect(r.outcome).toBe("failed"); // the fallback requeue's transient failure

    // status unchanged (still source_written); the live pending row is the
    // RESERVED requeue.
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
    const requeueRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, requeueId)))[0]!;
    expect(requeueRow.state).toBe("reserved");
    expect(requeueRow.superseded).toBe(false);

    // FIX (b): the superseded resume row must NOT be left `executing`.
    const resumeRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, resumeId)))[0]!;
    expect(resumeRow.superseded).toBe(true);
    expect(resumeRow.state).not.toBe("executing");

    // FIX (a): pendingEffectDecisions reports the ACTUAL pending kind (requeue),
    // not a state-derived `resume` guess.
    const pending = await f.outbox.pendingEffectDecisions();
    const mine = pending.find((p) => p.decision_id === id);
    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("requeue");
  });

  it("re-driving the reported (requeue) kind reaches terminal `resumed` with EXACTLY one requeue dispatch", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    f.resumeDispatcher.results = ["unreachable", "failed"]; // resume unreachable, requeue transient fail
    await f.outbox.runEffect(id, "resume");

    // The sweep re-derives the ACTUAL pending kind and re-drives it AS requeue.
    const pending = await f.outbox.pendingEffectDecisions();
    const mine = pending.find((p) => p.decision_id === id)!;
    expect(mine.kind).toBe("requeue");

    // simulate the sweep: run the reported kind for the reported decision.
    f.resumeDispatcher.results = ["acked"]; // the retry succeeds
    const r2 = await f.outbox.runEffect(mine.decision_id, mine.kind);
    expect(r2.status).toBe("resumed");

    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("resumed");
    // EXACTLY one requeue dispatch landed at the worker (idempotent marker).
    const requeueCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "requeue");
    expect(requeueCalls.length).toBe(2); // 1 failed transient attempt + 1 successful retry
    // but exactly ONE requeue marker (the worker dedups by effectId).
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    expect([...f.resumeDispatcher.applied].filter((a) => a === requeueId).length).toBe(1);
  });
});
