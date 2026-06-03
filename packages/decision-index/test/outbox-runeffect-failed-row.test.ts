import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";

type Fakes = ReturnType<typeof makeOutbox>;

function statusOf(t: TempDb, id: string): string {
  return t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!.status;
}

function liveReserved(t: TempDb, id: string) {
  return t.db
    .select()
    .from(outboxTable)
    .where(eq(outboxTable.decision_id, id))
    .all()
    .filter((o) => o.state === "reserved" && !o.superseded);
}

async function bringToWrite(t: TempDb, f: Fakes, id: string) {
  await answerItem(t, f.outbox, id); // -> answered_pending_source_write
}

/**
 * TOTAL CHOKEPOINT GUARD: the single effect-execution chokepoint
 * (executeReserved) must refuse to dispatch the adapter for any row that is not
 * currently a LIVE `reserved` row on a non-terminal, non-superseded decision —
 * regardless of whether the caller is reconcile() or the PUBLIC runEffect().
 *
 * The reconcile 0b limbo guard already handles an exhausted `state="failed"`
 * row on a still-non-terminal decision. This proves the PUBLIC runEffect() path
 * is equally safe: planting that same failed row and calling runEffect()
 * directly must NOT re-dispatch the adapter (reserve() no-ops on the existing
 * failed row, and executeReserved must catch the non-reserved state).
 */
describe("runEffect chokepoint: non-reserved persisted row", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("exhausted state=failed row on a NON-terminal decision -> runEffect does NOT dispatch the adapter; drives decision to failed; idempotent", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id); // answered_pending_source_write (non-terminal)

    // Plant the exhausted terminal-on-row write_response BEFORE any reconcile,
    // exactly as the OLD-split crash window would leave it.
    const writeId = f.outbox.effectIdFor(id, "write_response");
    t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "failed",
        attempts: 3,
        last_error: "writeResponse failed",
        created_at: FIXED_NOW,
      })
      .run();
    expect(statusOf(t, id)).toBe("answered_pending_source_write"); // non-terminal limbo

    const callsBefore = f.sourceSink.calls.length; // 0

    // PUBLIC runEffect path (NOT reconcile) — the exact double-dispatch vector.
    const r = await f.outbox.runEffect(id, "write_response");

    // Adapter must NOT be dispatched again.
    expect(f.sourceSink.calls.length).toBe(callsBefore);
    // Decision driven to failed via the idempotent terminal helper.
    expect(statusOf(t, id)).toBe("failed");
    expect(r.outcome).toBe("failed");
    expect(liveReserved(t, id)).toHaveLength(0);

    // Idempotent on repeat: a settled (failed) decision is a no-op — still no
    // adapter call, still failed, and runEffect does NOT throw.
    let r2!: ReturnType<typeof f.outbox.runEffect>;
    expect(() => (r2 = f.outbox.runEffect(id, "write_response"))).not.toThrow();
    expect(f.sourceSink.calls.length).toBe(callsBefore);
    expect(statusOf(t, id)).toBe("failed");
    expect(r2.outcome).not.toBe("committed"); // never re-dispatched/committed
  });

  it("regression: a normal LIVE reserved row still dispatches via runEffect", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    const callsBefore = f.sourceSink.calls.length;
    const r = await f.outbox.runEffect(id, "write_response");

    expect(f.sourceSink.calls.length).toBe(callsBefore + 1); // adapter WAS dispatched
    expect(r.outcome).toBe("committed");
    expect(statusOf(t, id)).toBe("source_written");
  });

  it("regression: a COMMITTED row is not re-dispatched (treated as already-applied)", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    // First write commits normally.
    const first = await f.outbox.runEffect(id, "write_response");
    expect(first.outcome).toBe("committed");
    expect(statusOf(t, id)).toBe("source_written");
    const callsAfterCommit = f.sourceSink.calls.length;

    // The committed row exists. Force the item's status back so the pure-state
    // preflight does NOT reject (write_response is illegal from source_written),
    // simulating a stray re-call while the committed row is still present.
    t.db
      .update(decisions)
      .set({ status: "answered_pending_source_write" })
      .where(eq(decisions.decision_id, id))
      .run();

    const r = await f.outbox.runEffect(id, "write_response");
    // committed row must NOT be re-dispatched.
    expect(f.sourceSink.calls.length).toBe(callsAfterCommit);
    expect(r.outcome).not.toBe("failed");
  });
});
