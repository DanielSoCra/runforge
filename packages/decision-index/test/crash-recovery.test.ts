import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";

describe("crash-after-write recovery (spec test 8)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("source ALREADY has the effect, SQLite lacks the committed transition -> reconcile advances WITHOUT re-writing", async () => {
    const id = await seedDecision(t.db);
    const { outbox, sourceSink } = makeOutbox(t);
    await answerItem(t, outbox, id); // -> answered_pending_source_write

    // Simulate a crash AFTER the source write but BEFORE the commit transaction:
    // the source already contains the deterministic effect, and the outbox row
    // is even missing. SQLite still shows answered_pending_source_write.
    const effId = await outbox.effectIdFor(id, "write_response");
    sourceSink.applied.add(effId); // source has it
    // (no outbox row, no status advance in SQLite)
    expect(
      (await t.db.select().from(outboxTable)).filter((o) => o.kind === "write_response"),
    ).toHaveLength(0);

    const callsBefore = sourceSink.calls.length;
    const results = await outbox.reconcile();

    // probed via SourceSink.exists -> applied -> advance, no re-write
    expect(sourceSink.calls.length).toBe(callsBefore); // never called writeResponse again
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("advanced");
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("source_written");
  });
});
