import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { IndexWriter } from "../src/index-writer.js";
import { ProtectedStore } from "@auto-claude/sanitizer-redaction";
import { SqliteQuarantine } from "../src/quarantine.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";
import { decisions } from "../src/schema.js";
import { TEST_PROTECTED_KEY } from "./helpers/temp-db.js";
import { join } from "node:path";

/**
 * IMPORTANT 3 — never fabricate a supersede etag.
 *
 * Old bug: when the freshness probe / observeRequest had no concrete current
 * source etag, the code fabricated `${old}-changed` / `"source-edited"` and
 * recorded it as `superseded_by`. A fabricated etag is unverifiable and can mask
 * a real source state. The fix: `source_changed` REQUIRES `currentSourceEtag`;
 * absent -> treat as `unknown` (fail-closed defer), never fabricate. observeRequest
 * requires a CONCRETE incoming source_etag to supersede.
 */
describe("IMPORTANT 3 — no fabricated supersede etag (fail-closed instead)", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("runResume: source_changed WITHOUT a concrete currentSourceEtag -> deferred (unknown), NOT a fabricated supersede", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    await f.outbox.runEffect(id, "write_response"); // -> source_written

    // A pathological probe: claims source_changed but carries NO currentSourceEtag.
    // This must be treated as unknown (defer), never fabricate `${old}-changed`.
    f.sourceSink.currentEtagResults = [{ status: "source_changed" }];

    const r = await f.outbox.runEffect(id, "requeue");
    expect(r.outcome).toBe("deferred"); // fail-closed, NOT superseded
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("source_written"); // unchanged, not superseded
    // and no fabricated superseded_by was recorded.
    expect(row.superseded_by).toBeNull();
    // markSuperseded must NOT have been called with a fabricated etag.
    expect(f.sourceSink.superseded.length).toBe(0);
  });

  it("runResume: source_changed WITH a concrete etag supersedes using that EXACT etag", async () => {
    const id = seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    await f.outbox.runEffect(id, "write_response");

    f.sourceSink.currentEtagResults = [{ status: "source_changed", currentSourceEtag: "concrete-new-etag" }];
    const r = await f.outbox.runEffect(id, "requeue");
    expect(r.outcome).toBe("superseded");
    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.superseded_by).toBe("concrete-new-etag"); // the REAL etag, never fabricated
  });

  function makeWriter() {
    const protectedDir = join(t.dir, "protected");
    const protectedStore = new ProtectedStore({ key: TEST_PROTECTED_KEY, dir: protectedDir, db: t.db });
    const quarantine = new SqliteQuarantine(t.db);
    return new IndexWriter({
      db: t.db,
      protectedStore,
      quarantine,
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date("2026-05-27T09:00:00.000Z"),
    });
  }

  function rawRequest(id: string, etag: string | undefined, question = "Proceed?"): Record<string, unknown> {
    const r: Record<string, unknown> = {
      decision_id: id,
      protocol_version: "1.0.0",
      source_url: "https://github.com/o/r/issues/1",
      source_event_id: "evt-1",
      deployment: "dep",
      run_id: "run-1",
      worker_session_id: "ws-1",
      phase: "impl",
      risk_class: "P1",
      question,
      context: "ctx",
      options: [{ id: "yes", label: "Yes" }],
      recommended_option: "yes",
      consequence_of_no_answer: "paused",
      reversibility: "reversible",
      expires_at: "2026-06-01T00:00:00.000Z",
      answer_schema: { kind: "option" },
      resume_mode: "requeue",
      idempotency_key: "idem-1",
    };
    if (etag !== undefined) r.source_etag = etag;
    return r;
  }

  it("observeRequest: a different-content edit with NO concrete incoming source_etag does NOT fabricate a supersede", () => {
    const w = makeWriter();
    const id = "01HOBS00000000000000000001";
    // admit with a concrete etag.
    w.observeRequest(rawRequest(id, "etag-original"));
    expect(w.reader.get(id)!.status).toBe("detected");

    // a re-observation WITHOUT a source_etag (cannot prove a real change) must NOT
    // fabricate `"source-edited"` and supersede. Fail-closed: no supersede.
    const out = w.observeRequest(rawRequest(id, undefined, "EDITED"));
    expect(out.outcome).not.toBe("superseded");
    const view = w.reader.get(id)!;
    expect(view.status).toBe("detected"); // still non-terminal, not superseded
    expect(view.superseded_by).toBeNull();
  });

  it("observeRequest: a different CONCRETE source_etag supersedes with that exact etag", () => {
    const w = makeWriter();
    const id = "01HOBS00000000000000000002";
    w.observeRequest(rawRequest(id, "etag-original"));

    const out = w.observeRequest(rawRequest(id, "etag-new-concrete", "EDITED"));
    expect(out.outcome).toBe("superseded");
    const view = w.reader.get(id)!;
    expect(view.status).toBe("superseded");
    expect(view.superseded_by).toBe("etag-new-concrete"); // the real etag
  });
});
