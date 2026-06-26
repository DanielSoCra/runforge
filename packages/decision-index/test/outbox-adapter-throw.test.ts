import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { FIXED_NOW } from "./helpers/effect-driver.js";
import { Outbox } from "../src/outbox.js";
import { apply } from "../src/state-machine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import type { Notifier, NotifyArgs, ProbeResult } from "../src/adapters/notifier.js";
import type {
  SourceSink,
  WriteResponseArgs,
  WriteResult,
  CurrentEtagResult,
} from "../src/adapters/source-sink.js";
import type {
  ResumeDispatcher,
  ResumeArgs,
  ResumeResult,
} from "../src/adapters/resume-dispatcher.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";

/**
 * BUG (verdict fix_before_flag_on / outbox.ts ~740): an adapter exception AFTER
 * claim() (a THROWN/REJECTED notify / currentEtag / writeResponse / resume
 * promise) bypasses recordFailure()+releaseClaim(), so the row is left stuck in
 * `executing`. Same-process reconcile skips current-generation `executing` rows
 * by design, so the row is stranded until process restart. The fix must wrap all
 * post-claim adapter awaits and record a failed attempt / release the claim — so
 * a throwing adapter NEVER leaves a row stuck `executing`.
 */

/** A notifier whose notify() rejects. */
class ThrowingNotifier implements Notifier {
  async notify(_args: NotifyArgs): Promise<"sent" | "failed"> {
    throw new Error("notify boom");
  }
  async probe(_effectId: string): Promise<ProbeResult> {
    return "absent";
  }
}

/** A source sink whose writeResponse() rejects. */
class ThrowingWriteSink extends FakeSourceSink {
  override async writeResponse(_args: WriteResponseArgs): Promise<WriteResult> {
    throw new Error("writeResponse boom");
  }
}

/** A source sink whose currentEtag() (freshness probe) rejects. */
class ThrowingEtagSink extends FakeSourceSink {
  override async currentEtag(
    _sourceLocator: string,
    _expectedSourceEtag?: string | null,
  ): Promise<CurrentEtagResult> {
    throw new Error("currentEtag boom");
  }
}

/** A resume dispatcher whose resume() rejects. */
class ThrowingResume implements ResumeDispatcher {
  async resume(_args: ResumeArgs): Promise<ResumeResult> {
    throw new Error("resume boom");
  }
  async status(_effectId: string): Promise<ProbeResult> {
    return "absent";
  }
}

async function statusOf(t: PgliteTestDb, id: string): Promise<string> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
}

async function rowState(t: PgliteTestDb, effectId: string) {
  return (await t.db.select().from(outboxTable).where(eq(outboxTable.id, effectId)))[0];
}

/** Build an Outbox over the temp db with the supplied (possibly throwing) adapters. */
function makeOutboxWith(
  t: PgliteTestDb,
  adapters: { notifier?: Notifier; sourceSink?: SourceSink; resumeDispatcher?: ResumeDispatcher },
  maxAttempts = 3,
) {
  return new Outbox({
    db: t.db,
    notifier: adapters.notifier ?? new FakeNotifier(),
    sourceSink: adapters.sourceSink ?? new FakeSourceSink(),
    resumeDispatcher: adapters.resumeDispatcher ?? new FakeResumeDispatcher(),
    clock: () => new Date(FIXED_NOW),
    channel: "slack",
    maxAttempts,
    // A FIXED generation so the same-process reconcile-skips-executing behavior is
    // exactly what production hits (current-generation executing rows are skipped).
    generation: "gen-1",
  });
}

/** Drive an item to answered_pending_source_write WITHOUT a throwing write sink. */
async function bringToWrite(t: PgliteTestDb, id: string) {
  // notify -> notified
  await apply(t.db, id, "notify", { semanticKey: "slack", now: FIXED_NOW });
  await apply(t.db, id, "opened", { semanticKey: "daniel", now: FIXED_NOW });
  await apply(t.db, id, "answer_submitted", {
    semanticKey: "resp-1",
    now: FIXED_NOW,
    answer: {
      response_idempotency_key: "resp-1",
      chosen_option: "yes",
      answerer: "daniel",
      answered_at: FIXED_NOW,
    },
  });
}

describe("outbox adapter-throw does not strand rows as executing", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("THROWING notify: row is recorded as a failed attempt and released, NOT left executing", async () => {
    const id = await seedDecision(t.db);
    const ob = makeOutboxWith(t, { notifier: new ThrowingNotifier() });
    const notifyId = await ob.effectIdFor(id, "notify");

    // The throw propagates (the daemon tick / driver sees it), but the row must
    // not be stranded executing.
    await expect(ob.runEffect(id, "notify")).rejects.toThrow(/notify boom/);

    const row = await rowState(t, notifyId);
    expect(row).toBeDefined();
    expect(row!.state).not.toBe("executing"); // <-- the bug: it WAS left executing
    // a transient (non-exhausted) failure is released back to reserved for retry.
    expect(row!.state).toBe("reserved");
    expect(row!.attempts).toBe(1);
    expect(row!.claimed_by).toBeNull();
    expect(await statusOf(t, id)).toBe("detected"); // not advanced
  });

  it("THROWING writeResponse: row released to reserved (not executing), decision unchanged", async () => {
    const id = await seedDecision(t.db);
    const ob = makeOutboxWith(t, { sourceSink: new ThrowingWriteSink() });
    await bringToWrite(t, id);
    const writeId = await ob.effectIdFor(id, "write_response");

    await expect(ob.runEffect(id, "write_response")).rejects.toThrow(/writeResponse boom/);

    const row = await rowState(t, writeId);
    expect(row!.state).not.toBe("executing");
    expect(row!.state).toBe("reserved");
    expect(row!.attempts).toBe(1);
    expect(await statusOf(t, id)).toBe("answered_pending_source_write");
  });

  it("THROWING currentEtag (freshness probe): resume row released, not stranded executing", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    // advance to source_written via a NON-throwing write sink.
    const setup = makeOutboxWith(t, {});
    await bringToWrite(t, id);
    await setup.runEffect(id, "write_response"); // -> source_written
    expect(await statusOf(t, id)).toBe("source_written");

    const ob = makeOutboxWith(t, { sourceSink: new ThrowingEtagSink() });
    const requeueId = await ob.effectIdFor(id, "requeue");
    await expect(ob.runEffect(id, "requeue")).rejects.toThrow(/currentEtag boom/);

    const row = await rowState(t, requeueId);
    expect(row!.state).not.toBe("executing");
    expect(row!.state).toBe("reserved");
    expect(await statusOf(t, id)).toBe("source_written"); // not resumed
  });

  it("THROWING resume: row released, decision not resumed", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const setup = makeOutboxWith(t, {});
    await bringToWrite(t, id);
    await setup.runEffect(id, "write_response"); // -> source_written
    expect(await statusOf(t, id)).toBe("source_written");

    const ob = makeOutboxWith(t, { resumeDispatcher: new ThrowingResume() });
    const requeueId = await ob.effectIdFor(id, "requeue");
    await expect(ob.runEffect(id, "requeue")).rejects.toThrow(/resume boom/);

    const row = await rowState(t, requeueId);
    expect(row!.state).not.toBe("executing");
    expect(row!.state).toBe("reserved");
    expect(await statusOf(t, id)).toBe("source_written");
  });

  it("EXHAUSTION: a persistently throwing adapter eventually drives the decision terminal (failed), never stuck executing", async () => {
    const id = await seedDecision(t.db);
    const ob = makeOutboxWith(t, { notifier: new ThrowingNotifier() }, 2); // maxAttempts=2
    const notifyId = await ob.effectIdFor(id, "notify");

    await expect(ob.runEffect(id, "notify")).rejects.toThrow(/notify boom/);
    expect((await rowState(t, notifyId))!.state).toBe("reserved"); // attempt 1, released

    await expect(ob.runEffect(id, "notify")).rejects.toThrow(/notify boom/);
    // attempt 2 == maxAttempts -> terminal failure
    const row = (await rowState(t, notifyId))!;
    expect(row.state).toBe("failed");
    expect(await statusOf(t, id)).toBe("failed");
  });
});
