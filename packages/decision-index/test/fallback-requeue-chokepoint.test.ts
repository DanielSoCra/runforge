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
 * FINDING 3 — the mid_run->requeue fallback must route through the SINGLE
 * adapter-dispatch chokepoint (executeReserved), honouring the row's
 * state/superseded/terminal guard.
 *
 * The bug: on `mid_run` unreachable, runResume reserved a `requeue` row, called
 * `claim(requeueSpec.id)` but IGNORED the boolean, then called
 * `resumeDispatcher.resume()` DIRECTLY — bypassing executeReserved's guard. So if
 * the requeue row was already claimed/committed/superseded (e.g. a concurrent
 * reconcile already recovered + dispatched it), the fallback dispatched a SECOND
 * requeue (double resume).
 *
 * The fix: dispatch the fallback requeue through executeReserved (or honour the
 * claim() result — refuse when the row is already claimed/settled). executeReserved
 * is then genuinely the single chokepoint.
 */
describe("FINDING 3 — fallback requeue routes through the single chokepoint", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("a fallback requeue whose row is already COMMITTED does NOT dispatch a second resume", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    // A concurrent path ALREADY reserved + dispatched + committed the fallback
    // requeue (the worker was requeued and the row is committed evidence). The
    // decision has not yet advanced past source_written in this racing view.
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    await t.db
      .insert(outboxTable)
      .values({
        id: requeueId,
        decision_id: id,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        semantic_key: requeueId.split(":").slice(2).join(":"),
        state: "committed",
        committed_at: "2026-05-27T01:59:45.000Z",
        attempts: 0,
        created_at: "2026-05-27T01:59:30.000Z",
      });
    // mark the requeue as already applied at the worker too.
    f.resumeDispatcher.applied.add(requeueId);

    const callsBefore = f.resumeDispatcher.calls.length;
    // Drive the resume: mid_run probes unreachable -> fallback to requeue. The
    // requeue row is already COMMITTED, so the chokepoint must REFUSE to
    // re-dispatch it.
    f.resumeDispatcher.results = ["unreachable"]; // the mid_run resume itself
    await f.outbox.runEffect(id, "resume");

    // Only the mid_run resume call happened (1); the fallback requeue was NOT
    // dispatched a second time because its row was already committed.
    const requeueCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "requeue");
    expect(requeueCalls.length).toBe(0);
    // and exactly the single mid_run dispatch was made beyond the baseline.
    expect(f.resumeDispatcher.calls.length).toBe(callsBefore + 1);

    // the committed requeue row stays committed (not re-touched).
    const requeueRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, requeueId)))[0]!;
    expect(requeueRow.state).toBe("committed");
  });

  it("a fallback requeue whose row is already SUPERSEDED/terminal-decision does NOT dispatch", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db.insert(workerSessions).values({ decision_id: id, requeue_command: "rq" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    // Pre-seed the requeue row as reserved but SUPERSEDED (a concurrent path
    // cancelled it as part of driving the decision terminal).
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    await t.db
      .insert(outboxTable)
      .values({
        id: requeueId,
        decision_id: id,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        semantic_key: requeueId.split(":").slice(2).join(":"),
        state: "reserved",
        superseded: true,
        attempts: 0,
        created_at: "2026-05-27T01:59:30.000Z",
      });

    const callsBefore = f.resumeDispatcher.calls.length;
    f.resumeDispatcher.results = ["unreachable"]; // mid_run resume unreachable
    await f.outbox.runEffect(id, "resume");

    // the superseded requeue row must NOT be dispatched.
    const requeueCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "requeue");
    expect(requeueCalls.length).toBe(0);
  });

  it("baseline preserved: a fresh fallback requeue (clean row) DOES dispatch and reaches terminal resumed", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "pm requeue --ref X", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    f.resumeDispatcher.results = ["unreachable", "acked"]; // mid_run fails, requeue ok
    const r = await f.outbox.runEffect(id, "resume");
    expect(r.kind).toBe("requeue");
    expect(r.status).toBe("resumed");
    const requeueCall = f.resumeDispatcher.calls.find((c) => c.mode === "requeue")!;
    expect(requeueCall.requeue_command).toBe("pm requeue --ref X");
    expect(requeueCall.work_request_ref).toBe("wr-1");
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("resumed");
  });
});
