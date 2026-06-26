import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { outbox as outboxTable, decisions } from "../src/schema.js";

/**
 * CRITICAL 1 — durable CAS claim before any adapter await.
 *
 * The bug: executeReserved read the row's state/superseded guard and then left
 * the row `reserved` while awaiting an adapter (notify/writeResponse/currentEtag/
 * resume). Two concurrent runEffect()/reconcile() passes for the SAME effect both
 * read `state='reserved'`, both passed the guard, and both dispatched the SAME
 * effect — and the GitHub adapters are check-then-post, so both posted (double-post).
 *
 * The fix: a committed `reserved -> executing` CAS transition in its OWN txn
 * BEFORE any adapter await. Only the claimer (the txn that flipped the row)
 * proceeds; a concurrent claim finds the row already `executing` and backs off
 * without touching the adapter.
 */
describe("CRITICAL 1 — concurrent runEffect claims the row before awaiting the adapter (no double-dispatch)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("two concurrent runEffect(id, write_response) invoke writeResponse at most once", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id); // -> answered_pending_source_write

    // make the adapter slow so both racing calls overlap inside the await window.
    let inFlight = 0;
    let maxConcurrent = 0;
    const realWrite = f.sourceSink.writeResponse.bind(f.sourceSink);
    f.sourceSink.writeResponse = async (args) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      const res = await realWrite(args);
      inFlight--;
      return res;
    };

    const [a, b] = await Promise.all([
      f.outbox.runEffect(id, "write_response"),
      f.outbox.runEffect(id, "write_response"),
    ]);

    // writeResponse must have been invoked AT MOST once, never overlapping.
    expect(f.sourceSink.calls.length).toBe(1);
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    // exactly one of the two reached committed; the other backed off (no dispatch).
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain("committed");

    // the decision advanced exactly once.
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
  });

  it("two concurrent runEffect(id, notify) invoke notify at most once", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);

    let inFlight = 0;
    let maxConcurrent = 0;
    const realNotify = f.notifier.notify.bind(f.notifier);
    f.notifier.notify = async (args) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      const res = await realNotify(args);
      inFlight--;
      return res;
    };

    await Promise.all([f.outbox.runEffect(id, "notify"), f.outbox.runEffect(id, "notify")]);

    expect(f.notifier.calls.length).toBe(1);
    expect(maxConcurrent).toBeLessThanOrEqual(1);
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("notified");
  });

  it("runEffect racing reconcile for the same effect dispatches the adapter at most once", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id); // answered_pending_source_write -> write_response expected

    let inFlight = 0;
    let maxConcurrent = 0;
    const realWrite = f.sourceSink.writeResponse.bind(f.sourceSink);
    f.sourceSink.writeResponse = async (args) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      const res = await realWrite(args);
      inFlight--;
      return res;
    };

    await Promise.all([f.outbox.runEffect(id, "write_response"), f.outbox.reconcile()]);

    expect(f.sourceSink.calls.length).toBe(1);
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  /** Manually create an `executing` (claimed-but-uncommitted) outbox row with an
   * OLD claim timestamp (lease expired), modelling a crash after the CAS claim. */
  async function forceExecutingCrash(id: string, effId: string) {
    await t.db
      .insert(outboxTable)
      .values({
        id: effId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: effId,
        payload_ref: null,
        state: "executing",
        superseded: false,
        attempts: 0,
        claimed_at: "2026-05-27T00:00:00.000Z", // far older than the 30s lease
        created_at: "2026-05-27T00:00:00.000Z",
      });
  }

  it("reconcile treats an `executing` row as crash-recoverable: applied marker -> advance (no re-dispatch)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id); // answered_pending_source_write; write_response is next

    // A crash AFTER the adapter applied the write but BEFORE the commit txn: the
    // marker is present at the sink, the row is `executing`, no applied_transition.
    const effId = await f.outbox.effectIdFor(id, "write_response");
    await forceExecutingCrash(id, effId);
    f.sourceSink.applied.add(effId); // marker already landed at the source

    const before = f.sourceSink.calls.length;
    const results = await f.outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("advanced");
    // applied marker -> NO re-dispatch.
    expect(f.sourceSink.calls.length).toBe(before);
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
  });

  it("reconcile treats an `executing` row whose marker is absent as re-claimable: re-executes", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);

    // A crash AFTER the CAS claim but BEFORE the adapter landed (marker absent).
    const effId = await f.outbox.effectIdFor(id, "write_response");
    await forceExecutingCrash(id, effId);
    // sink.applied is empty -> exists() returns absent.

    const before = f.sourceSink.calls.length;
    const results = await f.outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    // absent marker on a stale executing row -> re-claim + re-execute (a dispatch).
    expect(mine.action).toBe("re-executed");
    expect(f.sourceSink.calls.length).toBeGreaterThan(before);
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
  });

  it("a FRESH executing row (live in-flight) is NOT stolen by a concurrent reconcile", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);

    // make writeResponse slow so the row stays `executing` (fresh claim) across
    // a concurrent reconcile.
    const realWrite = f.sourceSink.writeResponse.bind(f.sourceSink);
    f.sourceSink.writeResponse = async (args) => {
      await new Promise((r) => setTimeout(r, 30));
      return realWrite(args);
    };

    const runP = f.outbox.runEffect(id, "write_response");
    await new Promise((r) => setTimeout(r, 5)); // let the claim land, write still in-flight
    await f.outbox.reconcile(); // must NOT re-dispatch the live executing row
    await runP;

    expect(f.sourceSink.calls.length).toBe(1);
  });
});
