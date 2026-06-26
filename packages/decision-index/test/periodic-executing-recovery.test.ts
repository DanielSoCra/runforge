import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { answerItem } from "./helpers/effect-driver.js";
import { Outbox } from "../src/outbox.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { outbox as outboxTable, decisions } from "../src/schema.js";

const FIXED_NOW = "2026-05-27T02:00:00.000Z";

function makeOutboxWithGeneration(t: PgliteTestDb, generation: string) {
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

/** Drive an item to `source_written` (write done; requeue not yet dispatched). */
async function toSourceWritten(t: PgliteTestDb, f: ReturnType<typeof makeOutboxWithGeneration>, id: string) {
  await answerItem(t, f.outbox, id);
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

/**
 * FINDING 1 — fast restart strands a prior-generation, lease-expired `executing`
 * row.
 *
 * `executingIsReclaimable()` keeps a DIFFERENT-generation `executing` row
 * non-reclaimable UNTIL its lease (`claimLeaseMs`) expires. Reconcile guard 0a
 * defers any non-reclaimable executing row. If the daemon restarts WITHIN the
 * lease, boot reconcile skips that row; once the lease later expires, nothing
 * revisits it — `pendingEffectDecisions()` (the drive-pending sweep) only
 * enumerates `state === 'reserved'` rows. The row is STRANDED: no
 * double-dispatch, but stuck until the next restart (violating the
 * no-silent-drop promise).
 *
 * FIX: recovery must be PERIODIC and cover reclaimable `executing` rows. The
 * daemon's sweep ALSO calls `reconcile()` each tick; `reconcile()` already
 * recovers a prior-generation, lease-expired executing row WITHOUT a restart. A
 * CURRENT-generation executing row is still NEVER touched.
 */
describe("FINDING 1 — periodic reconcile recovers a prior-gen lease-expired `executing` row (no restart)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  /** Insert the requeue outbox row directly in an `executing` claim whose lease
   *  has long expired (modelling a crashed prior process + a restart inside the
   *  lease that later elapsed), with its worker marker NOT yet visible. Mirrors
   *  the crash-window seeding used by owner-generation-claim.test.ts. */
  async function insertExecutingRequeue(decisionId: string, effId: string, runId: string, gen: string) {
    await t.db
      .insert(outboxTable)
      .values({
        id: effId,
        decision_id: decisionId,
        kind: "requeue",
        intended_transition: "resume_dispatch",
        // requeue's transition semantic key is the run_id (effectIdKey).
        semantic_key: runId,
        payload_ref: null,
        state: "executing",
        superseded: false,
        attempts: 0,
        // far older than the 30s lease -> reclaimable for a DIFFERENT generation.
        claimed_at: "2026-05-27T00:00:00.000Z",
        claimed_by: gen,
        created_at: "2026-05-27T00:00:00.000Z",
      });
  }

  it("THE STRAND: pendingEffectDecisions() (the old sweep) does NOT see a prior-gen executing requeue row, so a sweep that only drives pending strands it", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutboxWithGeneration(t, "gen-current");
    await toSourceWritten(t, f, id);

    // Model a crash mid-dispatch: the requeue row is `executing`, claimed by a
    // PRIOR (dead) generation, lease expired, marker absent.
    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    await insertExecutingRequeue(id, requeueId, "run-1", "gen-prior-dead");

    // The drive-pending sweep enumerator misses it (only `reserved` rows count).
    expect((await f.outbox.pendingEffectDecisions()).find((p) => p.decision_id === id)).toBeUndefined();
    // -> a sweep that ONLY consulted pendingEffectDecisions would NEVER recover it.
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written"); // still stranded
  });

  it("RECOVERY: a periodic reconcile tick recovers the prior-gen lease-expired executing requeue row to terminal `resumed` (no restart)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutboxWithGeneration(t, "gen-current");
    await toSourceWritten(t, f, id);

    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    await insertExecutingRequeue(id, requeueId, "run-1", "gen-prior-dead");
    // marker absent -> the prior process crashed before the worker requeued.

    const callsBefore = f.resumeDispatcher.calls.length;
    const results = await f.outbox.reconcile(); // <- what the periodic sweep now calls each tick

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.kind).toBe("requeue");
    // re-executed exactly once -> terminal resumed.
    expect(mine.status).toBe("resumed");
    expect(f.resumeDispatcher.calls.filter((c) => c.mode === "requeue").length).toBe(callsBefore + 1);
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("resumed");
  });

  it("NEVER touch a CURRENT-generation executing row: a periodic reconcile tick leaves a live in-flight requeue alone (round-2 guarantee)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const gen = "gen-current";
    const f = makeOutboxWithGeneration(t, gen);
    await toSourceWritten(t, f, id);

    const requeueId = await f.outbox.effectIdFor(id, "requeue");
    // executing, owned by THIS live generation, lease expired (slow-but-live call).
    await insertExecutingRequeue(id, requeueId, "run-1", gen);

    const callsBefore = f.resumeDispatcher.calls.length;
    const results = await f.outbox.reconcile();

    // ownership gate: never reclaimed -> no dispatch, no advance.
    expect(f.resumeDispatcher.calls.length).toBe(callsBefore);
    expect(results.find((x) => x.decision_id === id)).toBeUndefined();
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
    const ob = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, requeueId)))[0]!;
    expect(ob.state).toBe("executing");
    expect(ob.claimed_by).toBe(gen);
  });
});
