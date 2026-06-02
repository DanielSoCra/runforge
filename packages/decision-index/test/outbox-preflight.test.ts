import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";
import { IllegalTransitionError } from "../src/transition-table.js";

/**
 * CRITICAL 1 — external effects must NOT run before the state guard.
 *
 * `runEffect(id, kind)` reserves + executes the adapter, but legality was only
 * checked later in commit()->apply(). So a `resume`/`write_response`/`notify`
 * requested on a status where it is illegal would call the adapter BEFORE the
 * IllegalTransitionError fired. The fix preflights the pure transition and
 * requires the requested effect to equal the state-derived expected effect
 * BEFORE any adapter call.
 */
describe("outbox preflight: illegal effects throw with ZERO adapter calls", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("resume on a non-source_written item throws and NEVER calls resumeDispatcher", async () => {
    const id = seedDecision(t.db); // status: detected
    const f = makeOutbox(t);

    await expect(f.outbox.runEffect(id, "resume")).rejects.toThrow(IllegalTransitionError);

    // the adapter must not have been touched at all
    expect(f.resumeDispatcher.calls).toHaveLength(0);
    // no reserved outbox row should leak either
    expect(t.db.select().from(outboxTable).all()).toHaveLength(0);
    // status unchanged
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("detected");
  });

  it("write_response before answering throws and NEVER calls sourceSink", async () => {
    const id = seedDecision(t.db); // status: detected (no answer yet)
    const f = makeOutbox(t);

    await expect(f.outbox.runEffect(id, "write_response")).rejects.toThrow(IllegalTransitionError);

    expect(f.sourceSink.calls).toHaveLength(0);
    expect(t.db.select().from(outboxTable).all()).toHaveLength(0);
  });

  it("notify on an already-viewed item throws and NEVER calls notifier", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    // advance past detected so notify is no longer the expected effect
    await answerItem(t, f.outbox, id); // -> answered_pending_source_write
    const notifyCallsBefore = f.notifier.calls.length;

    await expect(f.outbox.runEffect(id, "notify")).rejects.toThrow(IllegalTransitionError);

    expect(f.notifier.calls.length).toBe(notifyCallsBefore);
  });

  it("requeue on a non-source_written item throws and NEVER calls resumeDispatcher", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);

    await expect(f.outbox.runEffect(id, "requeue")).rejects.toThrow(IllegalTransitionError);
    expect(f.resumeDispatcher.calls).toHaveLength(0);
  });
});
