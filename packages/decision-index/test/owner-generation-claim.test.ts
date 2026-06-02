import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { Outbox } from "../src/outbox.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { outbox as outboxTable, decisions } from "../src/schema.js";

const FIXED_NOW = "2026-05-27T02:00:00.000Z";

/** Build an Outbox bound to an explicit generation id (for crash-recovery sims). */
function makeOutboxWithGeneration(t: TempDb, generation: string) {
  const notifier = new FakeNotifier();
  const sourceSink = new FakeSourceSink();
  const resumeDispatcher = new FakeResumeDispatcher();
  const outbox = new Outbox({
    db: t.db,
    notifier,
    sourceSink,
    resumeDispatcher,
    clock: () => new Date(FIXED_NOW),
    channel: "slack",
    generation,
  });
  return { outbox, notifier, sourceSink, resumeDispatcher };
}

/**
 * CRITICAL 1 (owner/process-generation token).
 *
 * The lease-only design could re-dispatch a LIVE slow effect: any `executing`
 * row older than `claimLeaseMs` (30s) was treated as crashed and re-executed.
 * But a GitHub adapter call (with withBackoff) can legitimately exceed 30s while
 * still LIVE — and if its marker isn't visible yet, reconcile re-dispatched ->
 * double-post.
 *
 * The fix: every claim records `claimed_by = <process generation>`. Reconcile may
 * reclaim an `executing` row ONLY if its `claimed_by !== currentGeneration` (a
 * previous, dead process). It NEVER steals an executing row owned by the CURRENT
 * live process, regardless of the lease — the current process serializes its own
 * writes, so its executing rows are genuinely in-flight.
 */
describe("CRITICAL 1 — owner/process-generation token gates reconcile reclaim of executing rows", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  /** Manually create an `executing` row claimed_by `gen` with an OLD (lease-
   *  expired) claim timestamp, modelling an effect mid-flight past the lease. */
  function forceExecuting(id: string, effId: string, gen: string) {
    t.db
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
        // far older than the 30s lease — the lease alone would say "reclaim".
        claimed_at: "2026-05-27T00:00:00.000Z",
        claimed_by: gen,
        created_at: "2026-05-27T00:00:00.000Z",
      })
      .run();
  }

  it("an `executing` row owned by the CURRENT generation — even PAST the lease — is NOT reclaimed/re-dispatched", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    const gen = "gen-current";
    const f = makeOutboxWithGeneration(t, gen);
    await answerItem(t, f.outbox, id); // answered_pending_source_write; write_response next

    const effId = f.outbox.effectIdFor(id, "write_response");
    // a LIVE slow effect of the CURRENT process: executing, lease-expired, marker
    // not yet visible at the sink (absent).
    forceExecuting(id, effId, gen);
    expect(f.sourceSink.applied.has(effId)).toBe(false);

    const before = f.sourceSink.calls.length;
    const results = await f.outbox.reconcile();

    // ownership gate: reconcile must NOT touch a row owned by the current live
    // generation — no re-dispatch, no advance.
    expect(f.sourceSink.calls.length).toBe(before);
    const mine = results.find((x) => x.decision_id === id);
    expect(mine).toBeUndefined();
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("answered_pending_source_write");
    // the executing row is untouched (still owned by the current generation).
    const ob = t.db.select().from(outboxTable).where(eq(outboxTable.id, effId)).all()[0]!;
    expect(ob.state).toBe("executing");
    expect(ob.claimed_by).toBe(gen);
  });

  it("an `executing` row owned by a DIFFERENT (prior, dead) generation IS reclaimed (crash recovery)", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    // current process is a NEW generation; the executing row is from a prior one.
    const f = makeOutboxWithGeneration(t, "gen-current");
    await answerItem(t, f.outbox, id);

    const effId = f.outbox.effectIdFor(id, "write_response");
    forceExecuting(id, effId, "gen-prior-dead");
    // marker absent at the sink -> crash before the adapter landed -> re-execute.

    const before = f.sourceSink.calls.length;
    const results = await f.outbox.reconcile();

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("re-executed");
    expect(f.sourceSink.calls.length).toBeGreaterThan(before);
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("source_written");
  });

  it("a prior-generation `executing` row whose marker is APPLIED advances without re-dispatch", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutboxWithGeneration(t, "gen-current");
    await answerItem(t, f.outbox, id);

    const effId = f.outbox.effectIdFor(id, "write_response");
    forceExecuting(id, effId, "gen-prior-dead");
    f.sourceSink.applied.add(effId); // the prior process DID land the write before dying

    const before = f.sourceSink.calls.length;
    const results = await f.outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("advanced");
    expect(f.sourceSink.calls.length).toBe(before); // applied marker -> no re-dispatch
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("source_written");
  });
});
