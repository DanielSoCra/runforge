import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, appliedTransitions, outbox as outboxTable } from "../src/schema.js";

async function toSourceWritten(t: PgliteTestDb, f: ReturnType<typeof makeOutbox>, id: string) {
  await answerItem(t, f.outbox, id);
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

async function statusOf(t: PgliteTestDb, id: string): Promise<string> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
}

async function transitionKeys(t: PgliteTestDb, id: string): Promise<string[]> {
  return (await t.db.select().from(appliedTransitions))
    .filter((k) => k.decision_id === id)
    .map((k) => k.transition_key);
}

/**
 * A4 — crash-safe requeue terminality. A confirmed requeue commits BOTH
 * resume_dispatch:<run_id> AND resume_ack:<run_id> atomically -> terminal
 * `resumed`. A crash that committed resume_dispatch but not resume_ack is
 * recovered by reconcile (marker applied -> apply resume_ack -> resumed; no
 * duplicate requeue dispatch).
 */
describe("crash-safe requeue terminality (A4)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("confirmed requeue -> terminal resumed with BOTH transition keys present", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" }); // run_id = run-1
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    const r = await f.outbox.runEffect(id, "requeue");
    expect(r.outcome).toBe("committed");
    expect(await statusOf(t, id)).toBe("resumed");

    const keys = await transitionKeys(t, id);
    expect(keys).toContain("resume_dispatch:run-1");
    expect(keys).toContain("resume_ack:run-1");

    // exactly ONE requeue dispatch
    expect(f.resumeDispatcher.calls.filter((c) => c.mode === "requeue")).toHaveLength(1);
  });

  it("crash after resume_dispatch before resume_ack -> reconcile reaches resumed, NO duplicate requeue dispatch", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    // Simulate the crash: resume_dispatch committed (status resume_requested, the
    // requeue marker IS present at the worker) but resume_ack never ran.
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    await t.db
      .insert(outboxTable)
      .values({
        id: requeueId,
        decision_id: id,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        semantic_key: "run-1",
        state: "reserved",
        attempts: 0,
        created_at: "2026-05-27T01:59:00.000Z",
      });
    // resume_dispatch was applied before the crash:
    const { apply } = await import("../src/state-machine.js");
    await apply(t.db, id, "resume_dispatch", { semanticKey: "run-1", now: "2026-05-27T01:59:00.000Z" });
    expect(await statusOf(t, id)).toBe("resume_requested");
    // the worker DID receive the requeue (marker applied):
    f.resumeDispatcher.applied.add(requeueId);

    const dispatchesBefore = f.resumeDispatcher.calls.length; // 0 real dispatches
    const results = await f.outbox.reconcile();

    // NO duplicate requeue dispatch — the marker was applied, only resume_ack fires.
    expect(f.resumeDispatcher.calls.length).toBe(dispatchesBefore);
    expect(await statusOf(t, id)).toBe("resumed");
    const keys = await transitionKeys(t, id);
    expect(keys).toContain("resume_dispatch:run-1");
    expect(keys).toContain("resume_ack:run-1");
    expect(results.find((x) => x.decision_id === id)).toBeDefined();

    // second reconcile is a no-op
    const callsBefore = f.resumeDispatcher.calls.length;
    await f.outbox.reconcile();
    expect(f.resumeDispatcher.calls.length).toBe(callsBefore);
    expect(await statusOf(t, id)).toBe("resumed");
  });

  it("crash after resume_dispatch, marker ABSENT -> reconcile re-dispatches the requeue then reaches resumed", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await toSourceWritten(t, f, id);

    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    const { apply } = await import("../src/state-machine.js");
    await apply(t.db, id, "resume_dispatch", { semanticKey: "run-1", now: "2026-05-27T01:59:00.000Z" });
    expect(await statusOf(t, id)).toBe("resume_requested");
    // marker deliberately NOT applied -> probe absent -> re-dispatch.

    const results = await f.outbox.reconcile();
    expect(f.resumeDispatcher.calls.filter((c) => c.mode === "requeue").length).toBeGreaterThanOrEqual(1);
    expect(await statusOf(t, id)).toBe("resumed");
    expect(results.find((x) => x.decision_id === id)).toBeDefined();
    // marker now present from the re-dispatch
    expect(f.resumeDispatcher.applied.has(requeueId)).toBe(true);
  });
});
