import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable, workerSessions } from "../src/schema.js";

async function toSourceWritten(t: TempDb, f: ReturnType<typeof makeOutbox>, id: string) {
  await answerItem(t, f.outbox, id);
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

/**
 * CRITICAL 4 — crash AFTER requeue ack but BEFORE commit, in the mid_run->requeue
 * fallback. Status stays `source_written` and resume_mode is `mid_run`, so a
 * naive state-derived reconcile derives only the RESUME id, probes resume
 * (absent), and dispatches REQUEUE AGAIN. The fix persists the fallback intent
 * (the reserved requeue outbox row) so reconcile probes the REQUEUE id, finds it
 * applied, and advances WITHOUT a second requeue dispatch.
 */
describe("requeue-fallback crash recovery (Finding 4)", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("REAL shape: BOTH reserved resume (absent) AND reserved requeue (applied) -> reconcile resolves the requeue, advances, ZERO new requeue dispatch", async () => {
    const id = seedDecision(t.db, { resume_mode: "mid_run" });
    t.db
      .insert(workerSessions)
      .values({ decision_id: id, requeue_command: "rq", work_request_ref: "wr-1" })
      .run();
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    // The mid_run resume id and the requeue id are DISTINCT (different effect kind).
    const resumeId = f.outbox.effectIdFor(id, "resume");
    const requeueId = f.outbox.effectIdFor(id, "requeue");
    expect(resumeId).not.toBe(requeueId);

    // CRITICAL C4 REAL shape: runEffect("resume") reserved the ORIGINAL resume row
    // first, THEN the fallback reserved the requeue row. The worker ACKED the
    // requeue (requeue id applied) but the commit txn never ran before the crash.
    // So BOTH rows are `reserved`, status is still source_written, resume probe
    // is ABSENT (never applied) and requeue probe is APPLIED.
    //
    // The bug: reconcile picks the FIRST reserved row (the older `resume`), probes
    // resume -> absent, falls through to state-derived `resume`, and dispatches
    // the fallback requeue AGAIN. The fix probes/resolves the APPLIED requeue row
    // and never re-dispatches off the superseded resume reservation.
    t.db
      .insert(outboxTable)
      .values({
        id: resumeId, // reserved FIRST (older) — the superseded reservation
        decision_id: id,
        kind: "resume",
        intended_transition: "resume_dispatch",
        state: "reserved",
        attempts: 0,
        created_at: "2026-05-27T01:59:00.000Z",
      })
      .run();
    t.db
      .insert(outboxTable)
      .values({
        id: requeueId, // reserved SECOND (the fallback) — the one actually applied
        decision_id: id,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        state: "reserved",
        attempts: 0,
        created_at: "2026-05-27T01:59:30.000Z",
      })
      .run();
    f.resumeDispatcher.applied.add(requeueId); // worker already requeued
    // resume id deliberately NOT applied (absent).

    const callsBefore = f.resumeDispatcher.calls.length; // 0 — no real dispatches yet
    const results = await f.outbox.reconcile();

    // No new dispatch of ANY kind: the superseded resume reservation must NOT
    // trigger a fresh requeue, and the applied requeue is not re-sent.
    expect(f.resumeDispatcher.calls.length).toBe(callsBefore);

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.kind).toBe("requeue"); // reconciled the REQUEUE id, not resume
    expect(mine.action).toBe("advanced");
    // A4: an applied requeue marker advances directly to terminal `resumed`.
    expect(mine.status).toBe("resumed");

    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("resumed");

    // the superseded resume reservation is left untouched (still reserved), but no
    // requeue was dispatched off it — the key invariant. The requeue row committed.
    const requeueRow = t.db.select().from(outboxTable).where(eq(outboxTable.id, requeueId)).all()[0]!;
    expect(requeueRow.state).toBe("committed");
  });
});
