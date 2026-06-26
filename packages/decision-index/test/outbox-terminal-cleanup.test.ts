import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable, workerSessions } from "../src/schema.js";
import { apply } from "../src/state-machine.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";

type Fakes = ReturnType<typeof makeOutbox>;

/** Live reserved rows for a decision: state=reserved AND not cancelled (superseded marker). */
async function liveReserved(t: PgliteTestDb, id: string) {
  return (await t.db.select().from(outboxTable).where(eq(outboxTable.decision_id, id))).filter(
    (o) => o.state === "reserved" && !o.superseded,
  );
}

async function bringToWrite(t: PgliteTestDb, f: Fakes, id: string) {
  await answerItem(t, f.outbox, id); // -> answered_pending_source_write
}

/**
 * HOLISTIC INVARIANT (terminal cleanup): a decision in ANY terminal state
 * (resumed / superseded / failed) must carry ZERO live reserved outbox rows,
 * and reconcile() must NEVER dispatch an external effect for a terminal
 * decision. This guards against a CLASS of stale external writes.
 */
describe("terminal-state outbox cleanup invariant", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("write_response precondition_failed -> superseded: reserved write_response row is cancelled; reconcile does NOT re-write", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    // The write probes precondition_failed -> decision is superseded.
    f.sourceSink.results = [{ status: "precondition_failed", currentSourceEtag: "etag-new" }];
    const r = await f.outbox.runEffect(id, "write_response");
    expect(r.outcome).toBe("superseded");
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "superseded",
    );

    // INVARIANT (a): the reserved write_response row is no longer live.
    expect(await liveReserved(t, id)).toHaveLength(0);

    // The source was written exactly once so far (the failed precondition call).
    const writeCallsBefore = f.sourceSink.calls.length;
    expect(writeCallsBefore).toBe(1);

    // A subsequent reconcile must NOT call writeResponse again, and must not throw.
    await expect(f.outbox.reconcile()).resolves.toBeDefined();
    expect(f.sourceSink.calls.length).toBe(1);

    // Still terminal, still no live reserved rows.
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "superseded",
    );
    expect(await liveReserved(t, id)).toHaveLength(0);
  });

  it("reserved row probes unknown -> decision failed AND row no longer live; later applied/absent flip does NOT execute/commit against failed", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id); // answered_pending_source_write, write_response reserved-able

    // Reserve the write_response row but DON'T execute (crash-before-execute).
    const writeId = await f.outbox.effectIdFor(id, "write_response");
    await t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });

    // Probe is indeterminate -> reconcile must fail the decision.
    f.sourceSink.probeUnknown = true;
    const results = await f.outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("failed");
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "failed",
    );

    // INVARIANT (a): the reserved row is no longer live after the decision failed.
    expect(await liveReserved(t, id)).toHaveLength(0);

    // Now the probe flips: pretend the effect IS present (applied) on retry.
    f.sourceSink.probeUnknown = false;
    f.sourceSink.applied.add(writeId);

    const writeCallsBefore = f.sourceSink.calls.length;
    // INVARIANT (b): even if a stale reserved row lingered, reconcile must NOT
    // execute/commit against a terminal (failed) decision.
    await expect(f.outbox.reconcile()).resolves.toBeDefined();
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore); // no new writeResponse
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "failed",
    );
    expect(await liveReserved(t, id)).toHaveLength(0);
  });

  it("general: a terminal decision has ZERO live reserved rows and reconcile is a no-op (resumed)", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db.insert(workerSessions).values({ decision_id: id, wake_command: "wake" });
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);
    await f.outbox.runEffect(id, "write_response"); // -> source_written
    await f.outbox.runEffect(id, "resume"); // -> resume_requested
    // resume_ack -> resumed (terminal)
    await apply(t.db, id, "resume_ack", { semanticKey: "run-1", now: FIXED_NOW });
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "resumed",
    );

    expect(await liveReserved(t, id)).toHaveLength(0);

    const resumeCallsBefore = f.resumeDispatcher.calls.length;
    const writeCallsBefore = f.sourceSink.calls.length;
    const notifyCallsBefore = f.notifier.calls.length;
    await f.outbox.reconcile();
    expect(f.resumeDispatcher.calls.length).toBe(resumeCallsBefore);
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore);
    expect(f.notifier.calls.length).toBe(notifyCallsBefore);
  });

  it("defensive guard: a stale reserved row whose decision was made terminal out-of-band is cancelled, never dispatched", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id);

    // Reserve a write_response row that probes ABSENT (would normally re-execute).
    const writeId = await f.outbox.effectIdFor(id, "write_response");
    await t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });

    // Force the decision terminal out-of-band (e.g. a concurrent supersede),
    // leaving the reserved row behind WITHOUT cleanup having run.
    await t.db
      .update(decisions)
      .set({ status: "superseded", updated_at: FIXED_NOW })
      .where(eq(decisions.decision_id, id));

    const writeCallsBefore = f.sourceSink.calls.length;
    await expect(f.outbox.reconcile()).resolves.toBeDefined();
    // INVARIANT (b): no external write dispatched for the terminal decision.
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore);
    // row cancelled, not left live.
    expect(await liveReserved(t, id)).toHaveLength(0);
  });

  it("regression: a normal non-terminal, non-superseded reserved row still executes", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await bringToWrite(t, f, id); // answered_pending_source_write

    // Reserve a write_response row (crash-before-execute) that probes ABSENT.
    const writeId = await f.outbox.effectIdFor(id, "write_response");
    await t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });

    const writeCallsBefore = f.sourceSink.calls.length;
    await f.outbox.reconcile();
    // The non-terminal, non-superseded reserved row DID re-execute (write sent).
    expect(f.sourceSink.calls.length).toBe(writeCallsBefore + 1);
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "source_written",
    );
  });
});

/**
 * UNIFIED FIX (b): the act of a decision ADVANCING to a terminal status must
 * cancel its outstanding non-committed reserved rows at the REAL chokepoint
 * (state-machine.apply), regardless of which path advanced it. This covers
 * applyEvent's direct terminal events (resume_ack -> resumed,
 * source_superseded -> superseded), so the invariant "terminal transitions
 * leave ZERO live reserved rows at transition time" holds IMMEDIATELY — not
 * only after a later reconcile.
 */
describe("applyEvent terminal transitions cancel live reserved rows at transition time", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;
  let resumeDispatcher: FakeResumeDispatcher;

  beforeEach(async () => {
    t = await makePgliteDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-cleanup-"));
    resumeDispatcher = new FakeResumeDispatcher();
    writer = new IndexWriter({
      db: t.db,
      protectedStore: new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db }),
      quarantine: new PgQuarantine(t.db),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher,
      clock: () => new Date(FIXED_NOW),
      channel: "slack",
    });
  });
  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  /** Drive detected -> source_written via the writer's public effect API. */
  async function toSourceWrittenViaWriter(id: string) {
    await writer.runEffect(id, "notify"); // detected -> notified
    await writer.applyEvent(id, "opened", { semanticKey: "daniel" }); // -> viewed
    await writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: FIXED_NOW,
      },
    }); // -> answered_pending_source_write
    await writer.runEffect(id, "write_response"); // -> source_written
  }

  it("resume_ack -> resumed via applyEvent: ZERO live reserved rows immediately at transition time", async () => {
    const id = await seedDecision(t.db, { resume_mode: "mid_run" });
    await t.db.insert(workerSessions).values({ decision_id: id, wake_command: "wake" });

    await toSourceWrittenViaWriter(id);
    // A4: the outbox now commits resume_dispatch+resume_ack atomically, so to
    // exercise apply()'s terminal-cleanup hook for a DIRECT resume_ack we drive
    // resume_dispatch via the pure state machine (leaving the item at the
    // non-terminal resume_requested) then plant a reserved row before the ack.
    await apply(t.db, id, "resume_dispatch", { semanticKey: "run-1", now: FIXED_NOW });
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "resume_requested",
    );

    // Plant a lingering live reserved row (e.g. a notify/re_notify that was
    // reserved but never committed) BEFORE the terminal transition.
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

    expect(await liveReserved(t, id)).toHaveLength(1);

    // Terminal advance via applyEvent (NOT through an Outbox commit path).
    await writer.applyEvent(id, "resume_ack", { semanticKey: "run-1" });
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "resumed",
    );

    // INVARIANT: zero live reserved rows IMMEDIATELY, no reconcile needed.
    expect(await liveReserved(t, id)).toHaveLength(0);
  });

  it("source_superseded -> superseded via applyEvent: ZERO live reserved rows immediately at transition time", async () => {
    const id = await seedDecision(t.db);
    await writer.runEffect(id, "notify"); // -> notified
    await writer.applyEvent(id, "opened", { semanticKey: "daniel" }); // -> viewed
    await writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: FIXED_NOW,
      },
    }); // -> answered_pending_source_write

    // A write_response row is reserved-but-not-committed (crash-before-execute).
    const writeId = `${id}:write_response:${id}`;
    await t.db
      .insert(outboxTable)
      .values({
        id: writeId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        semantic_key: writeId,
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    expect(await liveReserved(t, id)).toHaveLength(1);

    // Out-of-band source change supersedes via applyEvent (direct terminal event).
    await writer.applyEvent(id, "source_superseded", { semanticKey: "etag-2", superseded_by: "etag-2" });
    expect((await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status).toBe(
      "superseded",
    );

    // INVARIANT: zero live reserved rows IMMEDIATELY at transition time.
    expect(await liveReserved(t, id)).toHaveLength(0);
  });
});
