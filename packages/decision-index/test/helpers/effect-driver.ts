import type { TempDb } from "./temp-db.js";
import { apply } from "../../src/state-machine.js";
import { Outbox } from "../../src/outbox.js";
import { FakeNotifier } from "../../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../../src/adapters/fakes/fake-resume-dispatcher.js";

export const FIXED_NOW = "2026-05-27T02:00:00.000Z";

export function makeOutbox(t: TempDb) {
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
  });
  return { outbox, notifier, sourceSink, resumeDispatcher };
}

/** Drive an item from detected to viewed+answered (ready for write_response). */
export async function answerItem(t: TempDb, outbox: Outbox, id: string) {
  await outbox.runEffect(id, "notify"); // detected -> notified
  apply(t.db, id, "opened", { semanticKey: "daniel", now: FIXED_NOW }); // -> viewed
  apply(t.db, id, "answer_submitted", {
    semanticKey: "resp-1",
    now: FIXED_NOW,
    answer: {
      response_idempotency_key: "resp-1",
      chosen_option: "yes",
      answerer: "daniel",
      answered_at: FIXED_NOW,
    },
  }); // -> answered_pending_source_write
}
