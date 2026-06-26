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
 * BUG (supersession-aware absent-reserved recovery). The mid_run resume and its
 * fallback requeue are NOT independent: when a mid_run resume probes unreachable,
 * a fallback requeue is reserved that SUPERSEDES the resume. In the crash window
 * BOTH can be reserved+absent (reserved before execute). The buggy reconcile
 * re-executes EVERY absent reserved row, so it dispatches BOTH a resume (mid_run
 * wake) AND a requeue (restart) for the same decision — or double-dispatches the
 * fallback. The fix marks the resume reservation superseded when the fallback
 * requeue is reserved, so reconcile re-executes ONLY the live requeue.
 */
describe("absent-reserved recovery: resume/requeue supersession", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("BOTH resume (absent) AND fallback requeue (absent) reserved -> reconcile dispatches ONLY requeue", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    const resumeId = await f.outbox.effectIdFor(id, "resume");
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    expect(resumeId).not.toBe(requeueId);

    // Crash window: the mid_run resume probed unreachable, the fallback reserved a
    // requeue (which supersedes the resume), but the worker crashed BEFORE either
    // executed. So BOTH rows are `reserved` and BOTH probe ABSENT. The resume row
    // carries the durable `superseded` marker set when the fallback was reserved.
    await t.db
      .insert(outboxTable)
      .values({
        id: resumeId,
        decision_id: id,
        kind: "resume",
        intended_transition: "resume_dispatch",
        state: "reserved",
        superseded: true, // marked superseded by the fallback requeue
        attempts: 0,
        created_at: "2026-05-27T01:59:00.000Z",
      });
    await t.db
      .insert(outboxTable)
      .values({
        id: requeueId,
        decision_id: id,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        state: "reserved",
        attempts: 0,
        created_at: "2026-05-27T01:59:30.000Z",
      });
    // Neither applied: both probe absent.

    const results = await f.outbox.reconcile();

    // Exactly ONE dispatch, and it is the requeue. NO mid_run resume wake.
    const resumeCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "mid_run");
    const requeueCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "requeue");
    expect(resumeCalls.length).toBe(0);
    expect(requeueCalls.length).toBe(1);

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.kind).toBe("requeue");
    // A4: a confirmed requeue lands directly in terminal `resumed`.
    expect(mine.status).toBe("resumed");

    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("resumed");

    // No stuck reserved rows: requeue committed, the superseded resume is resolved
    // (not left lingering as reserved+live).
    const reservedAfter = (
      await t.db.select().from(outboxTable).where(eq(outboxTable.decision_id, id))
    ).filter((o) => o.state === "reserved" && !o.superseded);
    expect(reservedAfter.length).toBe(0);

    // A second reconcile is a no-op (no further dispatch, no state change).
    const callsBefore = f.resumeDispatcher.calls.length;
    await f.outbox.reconcile();
    expect(f.resumeDispatcher.calls.length).toBe(callsBefore);
    const row2 = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row2.status).toBe("resumed");
  });

  it("UNIFIED GUARD: after fallback supersedes the resume row and requeue fails (status still source_written), a retry runEffect(resume) does NOT dispatch a mid_run wake", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, wake_command: "wake", requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id); // -> source_written

    // The mid_run resume probes unreachable -> fallback reserves a requeue (which
    // supersedes the resume reservation) and the requeue dispatch transiently
    // FAILS. So the decision stays `source_written`, the `resume` outbox row is
    // marked superseded, and the `requeue` row stays reserved (bumped, retryable).
    f.resumeDispatcher.results = ["unreachable", "failed"];
    const r = await f.outbox.runEffect(id, "resume");
    expect(r.outcome).toBe("failed");
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "source_written",
    );
    const resumeId = await f.outbox.effectIdFor(id, "resume");
    const resumeRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, resumeId)))[0]!;
    expect(resumeRow.superseded).toBe(true);

    const midRunBefore = f.resumeDispatcher.calls.filter((c) => c.mode === "mid_run").length;

    // BUG: a retry runEffect(id,"resume") passes the pure-state preflight
    // (source_written -> resume_dispatch is legal) and the decision is NOT
    // terminal, so the old guard let it dispatch the STALE mid_run wake again.
    // The unified guard must REFUSE because the reserved row is superseded.
    const retry = await f.outbox.runEffect(id, "resume");
    expect(retry.outcome).toBe("superseded");

    // No NEW mid_run wake was dispatched by the retry.
    const midRunAfter = f.resumeDispatcher.calls.filter((c) => c.mode === "mid_run").length;
    expect(midRunAfter).toBe(midRunBefore);

    // The live recovery path is the requeue, which is still reserved+live.
    const liveRequeue = (
      await t.db.select().from(outboxTable).where(eq(outboxTable.decision_id, id))
    ).filter((o) => o.kind === "requeue" && o.state === "reserved" && !o.superseded);
    expect(liveRequeue.length).toBe(1);
  });

  it("lone resume (absent) reserved, no fallback -> reconcile still re-executes resume", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({ decision_id: id, wake_command: "wake", requeue_command: "rq", work_request_ref: "wr-1" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    const resumeId = await f.outbox.effectIdFor(id, "resume");

    // Only a resume reservation, absent, NOT superseded — the worker is reachable
    // again on retry, so the resume must re-execute as a mid_run wake.
    await t.db
      .insert(outboxTable)
      .values({
        id: resumeId,
        decision_id: id,
        kind: "resume",
        intended_transition: "resume_dispatch",
        state: "reserved",
        attempts: 0,
        created_at: "2026-05-27T01:59:00.000Z",
      });

    const results = await f.outbox.reconcile();

    const resumeCalls = f.resumeDispatcher.calls.filter((c) => c.mode === "mid_run");
    expect(resumeCalls.length).toBe(1);

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.kind).toBe("resume");
    // A4: a confirmed resume lands directly in terminal `resumed`.
    expect(mine.status).toBe("resumed");
  });
});
