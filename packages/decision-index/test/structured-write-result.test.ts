import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions } from "../src/schema.js";

/**
 * A2 — structured WriteResult + concrete current-source etag. A
 * precondition_failed result must persist the CONCRETE currentSourceEtag as
 * superseded_by (never a fabricated `${old}-changed` string). written/failed
 * keep their existing semantics. writeResponse must receive the source locator.
 */
describe("structured WriteResult + concrete current-source etag (A2)", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("precondition_failed carries the concrete currentSourceEtag -> superseded_by is that etag, no fabricated string", async () => {
    const id = seedDecision(t.db); // source_etag = etag-0
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);

    f.sourceSink.results = [{ status: "precondition_failed", currentSourceEtag: "etag-REAL-99" }];
    const r = await f.outbox.runEffect(id, "write_response");
    expect(r.outcome).toBe("superseded");

    const row = t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!;
    expect(row.status).toBe("superseded");
    // the CONCRETE etag — not "etag-0-changed"
    expect(row.superseded_by).toBe("etag-REAL-99");
    expect(row.superseded_by).not.toMatch(/-changed$/);
    // the sink was told to mark superseded with the concrete etag
    expect(f.sourceSink.superseded).toContainEqual({ decision_id: id, newEtag: "etag-REAL-99" });
  });

  it("writeResponse receives the operational source locator (source_url)", async () => {
    const id = seedDecision(t.db); // source_url = https://example.test/1
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    await f.outbox.runEffect(id, "write_response");
    const call = f.sourceSink.calls[f.sourceSink.calls.length - 1]!;
    expect(call.sourceLocator).toBe("https://example.test/1");
  });

  it("a written result advances to source_written unchanged", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    f.sourceSink.results = [{ status: "written" }];
    const r = await f.outbox.runEffect(id, "write_response");
    expect(r.outcome).toBe("committed");
    expect(t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!.status).toBe(
      "source_written",
    );
  });

  it("a failed result (with error) records the failure without superseding", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    f.sourceSink.results = [{ status: "failed", error: "boom" }];
    const r = await f.outbox.runEffect(id, "write_response");
    expect(r.outcome).toBe("failed");
    // still retryable (non-terminal) — one failure < maxAttempts
    expect(t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!.status).toBe(
      "answered_pending_source_write",
    );
  });

  it("currentEtag probe returns equal by default, source_changed/unknown when scripted", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    // default: equal echoing the expected etag
    expect(await f.sourceSink.currentEtag("loc", "etag-0")).toEqual({
      status: "equal",
      currentSourceEtag: "etag-0",
    });
    f.sourceSink.changedSourceEtag = "etag-7";
    expect(await f.sourceSink.currentEtag("loc", "etag-0")).toEqual({
      status: "source_changed",
      currentSourceEtag: "etag-7",
    });
    f.sourceSink.changedSourceEtag = null;
    f.sourceSink.currentEtagUnknown = true;
    expect(await f.sourceSink.currentEtag("loc", "etag-0")).toEqual({ status: "unknown" });
  });
});
