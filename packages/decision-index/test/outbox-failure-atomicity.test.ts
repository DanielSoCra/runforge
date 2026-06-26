import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";

type Fakes = ReturnType<typeof makeOutbox>;

/** Live reserved rows for a decision: state=reserved AND not cancelled (superseded marker). */
async function liveReserved(t: PgliteTestDb, id: string) {
  return (await t.db.select().from(outboxTable).where(eq(outboxTable.decision_id, id))).filter(
    (o) => o.state === "reserved" && !o.superseded,
  );
}

async function statusOf(t: PgliteTestDb, id: string): Promise<string> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
}

async function bringToWrite(t: PgliteTestDb, f: Fakes, id: string) {
  await answerItem(t, f.outbox, id); // -> answered_pending_source_write
}

/**
 * CRASH-ATOMICITY of the FAILURE transition.
 *
 * A write_response (or any effect) that exhausts its attempts must drive the
 * decision to `failed`, mark the triggering outbox row terminal, AND cancel the
 * decision's other reserved rows — all ATOMICALLY. A crash mid-way must never
 * leave a `state="failed"` exhausted outbox row attached to a NON-terminal
 * decision that reconcile would then re-derive + re-dispatch (double external
 * effect).
 */
describe("outbox failure-transition crash atomicity", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("atomic failure: exhausted write_response -> decision failed with ZERO live reserved rows immediately", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    // Plant a SIBLING live reserved row (e.g. a re_notify reserved but never
    // committed) BEFORE the failure transition.
    await t.db
      .insert(outboxTable)
      .values({
        id: `${id}:notify:slack:cycle-2`,
        decision_id: id,
        kind: "notify",
        intended_transition: "re_notify",
        semantic_key: "cycle-2",
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    expect((await liveReserved(t, id)).length).toBeGreaterThanOrEqual(1);

    // write_response fails maxAttempts times -> exhausted -> failed.
    f.sourceSink.results = [{ status: "failed", error: "x" }, { status: "failed", error: "x" }, { status: "failed", error: "x" }];
    await f.outbox.runEffect(id, "write_response");
    await f.outbox.runEffect(id, "write_response");
    const r3 = await f.outbox.runEffect(id, "write_response");
    expect(r3.outcome).toBe("failed");
    expect(await statusOf(t, id)).toBe("failed");

    // INVARIANT (a): a terminal (failed) decision owns ZERO live reserved rows
    // IMMEDIATELY at transition time (atomic cleanup) — no reconcile needed.
    expect(await liveReserved(t, id)).toHaveLength(0);

    // The triggering write_response outbox row is terminal (state="failed").
    const writeId = await f.outbox.effectIdFor(id, "write_response");
    const writeRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, writeId)))[0]!;
    expect(writeRow.state).toBe("failed");
  });

  it("crash LIMBO: outbox row already state=failed+exhausted but decision still non-terminal -> reconcile drives to failed WITHOUT re-dispatching the adapter", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id); // answered_pending_source_write

    // Simulate the crash window: bumpFailure() committed the outbox row to
    // state="failed" with attempts exhausted, but the process died BEFORE the
    // decision was marked failed. The decision is still non-terminal.
    const writeId = await f.outbox.effectIdFor(id, "write_response");
    await t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "failed", // terminal-on-row, exhausted
        attempts: 3,
        last_error: "writeResponse failed",
        created_at: FIXED_NOW,
      });
    expect(await statusOf(t, id)).toBe("answered_pending_source_write"); // NON-terminal limbo

    const writeCallsBefore = f.sourceSink.calls.length; // 0

    // Reconcile must drive the decision to `failed` (idempotently re-apply the
    // terminal transition) and must NOT call writeResponse again.
    await f.outbox.reconcile();

    expect(await statusOf(t, id)).toBe("failed");
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore); // adapter NOT re-dispatched
    expect(await liveReserved(t, id)).toHaveLength(0);

    // Idempotent: a second reconcile is a no-op.
    await f.outbox.reconcile();
    expect(await statusOf(t, id)).toBe("failed");
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore);
  });

  it("regression: a TRANSIENT (non-exhausted) failure still retries normally", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    // One failure, then success. The decision must NOT fail; the write retries.
    f.sourceSink.results = [{ status: "failed", error: "x" }, { status: "written" }];
    const r1 = await f.outbox.runEffect(id, "write_response");
    expect(r1.outcome).toBe("failed");
    expect(await statusOf(t, id)).toBe("answered_pending_source_write"); // still retryable

    // The reserved row is still LIVE (not terminal) so a retry can proceed.
    expect((await liveReserved(t, id)).length).toBeGreaterThanOrEqual(1);

    const r2 = await f.outbox.runEffect(id, "write_response");
    expect(r2.outcome).toBe("committed");
    expect(await statusOf(t, id)).toBe("source_written");
  });
});
