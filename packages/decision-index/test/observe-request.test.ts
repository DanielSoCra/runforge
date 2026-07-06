import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb, TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@runforge/sanitizer-redaction";
import { PgQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { PROTOCOL_VERSION } from "@runforge/decision-protocol";
import { decisions } from "../src/schema.js";
import { apply } from "../src/state-machine.js";

const NOW = "2026-05-27T05:00:00.000Z";

function rawRequest(id: string, etag: string): unknown {
  return {
    decision_id: id,
    protocol_version: PROTOCOL_VERSION,
    source_url: "https://example.test/issues/7",
    source_etag: etag,
    source_event_id: "evt-1",
    deployment: "dep",
    run_id: "run-1",
    worker_session_id: "ws-1",
    phase: "impl",
    risk_class: "P1",
    question: "Proceed?",
    context: "ctx",
    options: [{ id: "yes", label: "Yes" }],
    recommended_option: "yes",
    consequence_of_no_answer: "paused",
    reversibility: "reversible",
    expires_at: "2026-06-01T00:00:00.000Z",
    answer_schema: { kind: "option" },
    resume_mode: "mid_run",
    idempotency_key: "idem-1",
  };
}

async function statusOf(t: PgliteTestDb, id: string): Promise<string> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
}

describe("observeRequest dedup/supersede (A5/I6)", () => {
  let t: PgliteTestDb;
  let protectedDir: string;
  let writer: IndexWriter;
  beforeEach(async () => {
    t = await makePgliteDb();
    protectedDir = mkdtempSync(join(tmpdir(), "pm-prot-obs-"));
    writer = new IndexWriter({
      db: t.db,
      protectedStore: new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db }),
      quarantine: new PgQuarantine(t.db),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date(NOW),
      channel: "slack",
    });
  });
  afterEach(async () => {
    await t?.cleanup();
    rmSync(protectedDir, { recursive: true, force: true });
  });

  const ID = "01HOBSERVE0000000000000001";

  it("new decision_id -> admit (detected)", async () => {
    const r = await writer.observeRequest(rawRequest(ID, "etag-1"));
    expect(r.outcome).toBe("admitted");
    expect(r.decision_id).toBe(ID);
    expect(await statusOf(t, ID)).toBe("detected");
  });

  it("same id + same etag -> no-op, bumps last_seen_at, status unchanged", async () => {
    await writer.observeRequest(rawRequest(ID, "etag-1"));
    const r = await writer.observeRequest(rawRequest(ID, "etag-1"), "2026-05-27T06:00:00.000Z");
    expect(r.outcome).toBe("unchanged");
    expect(await statusOf(t, ID)).toBe("detected");
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, ID)))[0]!;
    expect(row.last_seen_at).toBe("2026-05-27T06:00:00.000Z");
  });

  it("same id + DIFFERENT etag -> supersede existing (terminal), superseded_by = new etag", async () => {
    await writer.observeRequest(rawRequest(ID, "etag-1"));
    const r = await writer.observeRequest(rawRequest(ID, "etag-EDITED"));
    expect(r.outcome).toBe("superseded");
    expect(await statusOf(t, ID)).toBe("superseded");
    expect(
      (await t.db.select().from(decisions).where(eq(decisions.decision_id, ID)))[0]!.superseded_by,
    ).toBe("etag-EDITED");
  });

  it("supersede from `detected` is legal (re-poll edited block before notify)", async () => {
    await writer.observeRequest(rawRequest(ID, "etag-1"));
    expect(await statusOf(t, ID)).toBe("detected"); // never notified
    const r = await writer.observeRequest(rawRequest(ID, "etag-2"));
    expect(r.outcome).toBe("superseded");
    expect(await statusOf(t, ID)).toBe("superseded");
  });

  it("edited block under a TERMINAL item leaves it settled (no re-supersede)", async () => {
    await writer.observeRequest(rawRequest(ID, "etag-1"));
    // drive to a terminal state out-of-band
    await apply(t.db, ID, "source_superseded", { semanticKey: "x", now: NOW, superseded_by: "x" });
    expect(await statusOf(t, ID)).toBe("superseded");
    const r = await writer.observeRequest(rawRequest(ID, "etag-99"));
    expect(r.outcome).toBe("unchanged");
    expect(await statusOf(t, ID)).toBe("superseded");
  });
});
