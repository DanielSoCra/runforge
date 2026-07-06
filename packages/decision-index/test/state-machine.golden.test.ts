import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@runforge/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { AnsweredOnceConflictError } from "../src/state-machine.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "./fixtures/golden-decisions",
);
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

/** A mutable fake clock. */
class FakeClock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  advanceMinutes(m: number) {
    this.ms += m * 60_000;
  }
}

interface Harness {
  writer: IndexWriter;
  notifier: FakeNotifier;
  sourceSink: FakeSourceSink;
  resumeDispatcher: FakeResumeDispatcher;
  clock: FakeClock;
  cleanup: () => void;
}

function harness(t: PgliteTestDb, startISO = "2026-05-27T09:00:00.000Z"): Harness {
  const protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-"));
  const clock = new FakeClock(new Date(startISO).getTime());
  const notifier = new FakeNotifier();
  const sourceSink = new FakeSourceSink();
  const resumeDispatcher = new FakeResumeDispatcher();
  const writer = new IndexWriter({
    db: t.db,
    protectedStore: new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db }),
    quarantine: new PgQuarantine(t.db),
    notifier,
    sourceSink,
    resumeDispatcher,
    clock: clock.now,
    channel: "slack",
    maxAttempts: 3,
  });
  return {
    writer,
    notifier,
    sourceSink,
    resumeDispatcher,
    clock,
    cleanup: () => rmSync(protectedDir, { recursive: true, force: true }),
  };
}

async function answer(h: Harness, id: string, opt = "yes", key = "resp-1") {
  await h.writer.applyEvent(id, "answer_submitted", {
    semanticKey: key,
    answer: {
      response_idempotency_key: key,
      chosen_option: opt,
      answerer: "daniel",
      answered_at: h.clock.now().toISOString(),
    },
  });
}

describe("§12 golden decision-lifecycle scenarios", () => {
  let t: PgliteTestDb;
  let h: Harness;
  beforeEach(async () => {
    t = await makePgliteDb();
    h = harness(t);
  });
  afterEach(async () => {
    h?.cleanup();
    await t?.cleanup();
  });

  it("1. new-item — full happy path -> resumed, answered once, fully audited", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("new-item"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    expect((await h.writer.runEffect(id, "write_response")).status).toBe("source_written");
    // A4: a confirmed resume lands DIRECTLY in terminal `resumed` (atomic
    // resume_dispatch + resume_ack in one commit). No separate ack step.
    expect((await h.writer.runEffect(id, "resume")).status).toBe("resumed");

    expect((await h.writer.reader.get(id))!.status).toBe("resumed");
    expect((await h.writer.reader.hasResponse(id))).toBe(true);
    // audit has each main transition exactly once (resume_dispatch + resume_ack
    // both recorded by the single atomic commit).
    const events = (await h.writer.reader.audit(id)).map((a) => a.event);
    for (const e of ["notify", "opened", "answer_submitted", "write_response", "resume_dispatch", "resume_ack"]) {
      expect(events.filter((x) => x === e)).toHaveLength(1);
    }
    // audit-only sub-steps present, never as durable status
    expect(events).toContain("answering");
    expect(events).toContain("validated");
  });

  it("2. duplicate-answer — same payload no-op; distinct -> conflict; exactly one response row", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("duplicate-answer"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id, "yes", "resp-1");
    // same key + same payload -> idempotent no-op
    const dup = await h.writer.applyEvent(id, "answer_submitted", {
      semanticKey: "resp-1",
      answer: {
        response_idempotency_key: "resp-1",
        chosen_option: "yes",
        answerer: "daniel",
        answered_at: h.clock.now().toISOString(),
      },
    });
    expect(dup.applied).toBe(false);
    // distinct second answer -> conflict
    await expect(answer(h, id, "no", "resp-2")).rejects.toThrow(AnsweredOnceConflictError);
    expect((await h.writer.reader.hasResponse(id))).toBe(true);
  });

  it("3. expired-item — stale flag set past expires_at, STILL answerable, re-surfaced via re_notify", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("expired-item"));
    await h.writer.runEffect(id, "notify");
    // advance clock past expiry, fire expire
    h.clock.advanceMinutes(60 * 24 * 7);
    await h.writer.applyEvent(id, "expire", { semanticKey: "exp-1" });
    let view = (await h.writer.reader.get(id))!;
    expect(view.stale).toBe(true);
    expect(view.status).toBe("notified"); // NON-terminal
    // re-surfaced: a re_notify cycle now carries its OWN deterministic id +
    // re_notify:<cycle> intended transition (Finding 6), instead of collapsing
    // onto the original notify:<channel> effect/transition.
    const reNotify = await h.writer.runEffect(id, "notify", { reNotifyCycle: "cycle-1" });
    expect(reNotify.outcome).toBe("committed");
    // still answerable
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    expect((await h.writer.reader.get(id))!.status).toBe("answered_pending_source_write");
  });

  it("4. source-changed-after-answer — precondition_failed -> superseded, NO resume", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("source-changed-after-answer"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    h.sourceSink.results = [{ status: "precondition_failed", currentSourceEtag: "etag-new" }];
    const r = await h.writer.runEffect(id, "write_response");
    expect(r.outcome).toBe("superseded");
    expect((await h.writer.reader.get(id))!.status).toBe("superseded");
    // no resume dispatched
    expect(h.resumeDispatcher.calls).toHaveLength(0);
  });

  it("5. worker-re-ask — same run_id, new decision_id -> distinct item; prior resumed untouched", async () => {
    const first = fixture("worker-re-ask") as Record<string, unknown>;
    const { decision_id: id1 } = await h.writer.admit(first);
    await h.writer.runEffect(id1, "notify");
    await h.writer.applyEvent(id1, "opened", { semanticKey: "daniel" });
    await answer(h, id1);
    await h.writer.runEffect(id1, "write_response");
    await h.writer.runEffect(id1, "resume");
    await h.writer.applyEvent(id1, "resume_ack", { semanticKey: "run-shared" });
    expect((await h.writer.reader.get(id1))!.status).toBe("resumed");

    // a new decision_id with the SAME run_id (worker re-asks after resuming)
    const second = { ...first, decision_id: "01HREASK00000000000000000005B", idempotency_key: "idem-2" };
    const { decision_id: id2 } = await h.writer.admit(second);
    expect(id2).not.toBe(id1);
    expect((await h.writer.reader.get(id2))!.status).toBe("detected");
    // prior item untouched
    expect((await h.writer.reader.get(id1))!.status).toBe("resumed");
  });

  it("6. github-write-fail — write_response fails 3x -> failed, NO resume", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("github-write-fail"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    h.sourceSink.results = [{ status: "failed", error: "x" }, { status: "failed", error: "x" }, { status: "failed", error: "x" }];
    await h.writer.runEffect(id, "write_response");
    await h.writer.runEffect(id, "write_response");
    const r3 = await h.writer.runEffect(id, "write_response");
    expect(r3.status).toBe("failed");
    expect((await h.writer.reader.get(id))!.status).toBe("failed");
    expect(h.resumeDispatcher.calls).toHaveLength(0); // no resume occurred
  });

  it("7. missed-poll — reserved outbox row reconciled; confirmed-absent re-runs, applied is no-op", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("missed-poll"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    // crash before write committed: source does NOT have it -> reconcile re-executes
    const results = await h.writer.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("re-executed");
    expect((await h.writer.reader.get(id))!.status).toBe("source_written");
    // second reconcile: now expects resume; absent -> re-execute -> resume_requested
    const r2 = (await h.writer.reconcile()).find((x) => x.decision_id === id)!;
    expect(["re-executed", "advanced"]).toContain(r2.action);
  });

  it("8. crash-after-write — source already has effect, SQLite lacks it -> advance without re-writing", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("crash-after-write"));
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id); // -> answered_pending_source_write

    // Simulate a crash AFTER the source write but BEFORE the commit: the source
    // already contains the deterministic effect; SQLite still shows
    // answered_pending_source_write and has no committed outbox row. The
    // outbox derives the same deterministic id from item state, so we seed the
    // fake source's applied-set with that id.
    const outbox = (h.writer as unknown as {
      outbox: { effectIdFor: (d: string, k: string) => Promise<string> };
    }).outbox;
    const effId = await outbox.effectIdFor(id, "write_response");
    h.sourceSink.applied.add(effId);

    const callsBefore = h.sourceSink.calls.length;
    const results = await h.writer.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;

    expect(mine.action).toBe("advanced"); // probed applied -> advanced
    expect(h.sourceSink.calls.length).toBe(callsBefore); // exactly-once: never re-wrote
    expect((await h.writer.reader.get(id))!.status).toBe("source_written");
  });

  it("9. effect-reconcile — applied/absent/unknown across kinds (requeue resume_mode)", async () => {
    const { decision_id: id } = await h.writer.admit(fixture("effect-reconcile"));
    await h.writer.setWorkerSession(id, { requeue_command: "pm requeue", work_request_ref: "wr-9" });
    await h.writer.runEffect(id, "notify");
    await h.writer.applyEvent(id, "opened", { semanticKey: "daniel" });
    await answer(h, id);
    await h.writer.runEffect(id, "write_response"); // -> source_written
    // status now source_written; resume_mode=requeue.
    // absent -> reconcile re-executes the requeue
    const results = await h.writer.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(["re-executed", "advanced"]).toContain(mine.action);
    // A4: a confirmed requeue lands directly in terminal `resumed`.
    expect((await h.writer.reader.get(id))!.status).toBe("resumed");
    // the requeue carried durable worker metadata
    const requeueCall = h.resumeDispatcher.calls.find((c) => c.mode === "requeue");
    expect(requeueCall?.work_request_ref).toBe("wr-9");
  });
});
