import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, workerSessions } from "../src/schema.js";

async function toSourceWritten(t: PgliteTestDb, f: ReturnType<typeof makeOutbox>, id: string) {
  await answerItem(t, f.outbox, id);
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

async function statusOf(t: PgliteTestDb, id: string): Promise<string> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
}

/**
 * A3 — fail-closed source-freshness guard before resume/requeue. Before
 * dispatching a resume for a source_written item, probe the CURRENT source etag.
 * Dispatch ONLY if positively confirmed equal. A source_changed result ->
 * source_superseded (concrete etag), no resume. An unknown/error probe -> do NOT
 * dispatch (leave reserved for a later retry); never resume on uncertainty.
 */
describe("source-freshness guard before resume (A3, fail-closed)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("changed source before resume -> superseded with concrete etag, NO resume dispatched", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    f.sourceSink.changedSourceEtag = "etag-CHANGED";
    const r = await f.outbox.runEffect(id, "requeue");
    expect(r.outcome).toBe("superseded");
    expect(await statusOf(t, id)).toBe("superseded");
    expect(
      (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.superseded_by,
    ).toBe("etag-CHANGED");
    // no requeue/resume dispatched
    expect(f.resumeDispatcher.calls).toHaveLength(0);
  });

  it("unknown probe -> no dispatch, decision stays source_written (leave reserved)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    f.sourceSink.currentEtagUnknown = true;
    const r = await f.outbox.runEffect(id, "requeue");
    expect(f.resumeDispatcher.calls).toHaveLength(0);
    expect(await statusOf(t, id)).toBe("source_written"); // not superseded, not resumed
    expect(r.outcome).not.toBe("committed");
  });

  it("equal etag -> resume dispatched normally", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    // default currentEtag = equal
    const r = await f.outbox.runEffect(id, "requeue");
    expect(f.resumeDispatcher.calls.length).toBeGreaterThanOrEqual(1);
    expect(r.outcome).toBe("committed");
  });

  it("reconcile resume path also applies the freshness guard: changed source -> superseded, no dispatch", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    await t.db.insert(workerSessions).values({ decision_id: id, requeue_command: "rq" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id); // source_written, requeue not yet dispatched

    // a poll/edit changed the source before reconcile re-derives the requeue
    f.sourceSink.changedSourceEtag = "etag-BOOT-CHANGED";
    const results = await f.outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id);
    expect(f.resumeDispatcher.calls).toHaveLength(0);
    expect(await statusOf(t, id)).toBe("superseded");
    expect(mine).toBeDefined();
  });
});
