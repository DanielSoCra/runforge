import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, workerSessions } from "../src/schema.js";

async function toSourceWritten(t: PgliteTestDb, outbox: ReturnType<typeof makeOutbox>["outbox"], id: string) {
  await answerItem(t, outbox, id);
  await outbox.runEffect(id, "write_response"); // -> source_written
}

describe("resume fallback (§7) mid_run -> requeue", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("mid_run unreachable -> falls back to requeue using worker_sessions.requeue_command", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db
      .insert(workerSessions)
      .values({
        decision_id: id,
        requeue_command: "pm requeue --ref X",
        work_request_ref: "wr-1",
        wake_command: "pm wake --ref X",
      });
    const { outbox, resumeDispatcher } = makeOutbox(t);
    await toSourceWritten(t, outbox, id);

    resumeDispatcher.results = ["unreachable", "acked"]; // mid_run fails, requeue succeeds
    const r = await outbox.runEffect(id, "resume");
    expect(r.kind).toBe("requeue");
    // A4: a confirmed (fallback) requeue lands directly in terminal `resumed`.
    expect(r.status).toBe("resumed");
    // the requeue call carried the durable worker metadata
    const requeueCall = resumeDispatcher.calls.find((c) => c.mode === "requeue")!;
    expect(requeueCall.requeue_command).toBe("pm requeue --ref X");
    expect(requeueCall.work_request_ref).toBe("wr-1");
  });

  it("requeue fails 3x -> failed", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    await t.db.insert(workerSessions).values({ decision_id: id, requeue_command: "rq" });
    const { outbox, resumeDispatcher } = makeOutbox(t);
    await toSourceWritten(t, outbox, id);

    resumeDispatcher.results = ["failed", "failed", "failed"];
    await outbox.runEffect(id, "requeue");
    await outbox.runEffect(id, "requeue");
    const r3 = await outbox.runEffect(id, "requeue");
    expect(r3.status).toBe("failed");
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("failed");
  });

  it("double-dispatch is a worker-side no-op (probe applied -> reconcile advances without re-dispatch)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    const { outbox, resumeDispatcher } = makeOutbox(t);
    await toSourceWritten(t, outbox, id);

    // worker already resumed (deterministic id pre-seeded as applied)
    const effId = await outbox.effectIdFor(id, "resume");
    resumeDispatcher.applied.add(effId);
    const callsBefore = resumeDispatcher.calls.length;
    const results = await outbox.reconcile();
    expect(resumeDispatcher.calls.length).toBe(callsBefore); // no re-dispatch
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("advanced");
    // A4: an applied resume marker advances directly to terminal `resumed`.
    expect(mine.status).toBe("resumed");
  });
});
