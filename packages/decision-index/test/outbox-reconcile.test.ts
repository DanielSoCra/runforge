import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem, FIXED_NOW } from "./helpers/effect-driver.js";
import { outbox as outboxTable, decisions } from "../src/schema.js";
import type { EffectKind } from "@auto-claude/decision-protocol";

describe("two-phase outbox", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("reserve -> execute -> commit advances state and marks committed", async () => {
    const id = await seedDecision(t.db);
    const { outbox, sourceSink } = makeOutbox(t);
    await answerItem(t, outbox, id);
    const r = await outbox.runEffect(id, "write_response");
    expect(r.status).toBe("source_written");
    expect(sourceSink.calls).toHaveLength(1);
    const row = (await t.db.select().from(outboxTable)).find((o) => o.kind === "write_response")!;
    expect(row.state).toBe("committed");
  });

  it("a reserved-but-not-executed effect re-runs on reconcile (absent -> re-execute)", async () => {
    const id = await seedDecision(t.db);
    const { outbox, sourceSink } = makeOutbox(t);
    await answerItem(t, outbox, id);
    // manually reserve an outbox row for write_response WITHOUT executing
    const effId = await outbox.effectIdFor(id, "write_response");
    await t.db
      .insert(outboxTable)
      .values({
        id: effId,
        decision_id: id,
        kind: "write_response",
        intended_transition: "write_response",
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    // source does NOT have it yet -> reconcile probes absent -> re-executes
    const results = await outbox.reconcile();
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine.action).toBe("re-executed");
    expect(mine.status).toBe("source_written");
    expect(sourceSink.calls).toHaveLength(1);
  });

  it("already-committed effect is a no-op on reconcile (status past it)", async () => {
    const id = await seedDecision(t.db);
    const { outbox, sourceSink } = makeOutbox(t);
    await answerItem(t, outbox, id);
    await outbox.runEffect(id, "write_response"); // -> source_written, committed
    const callsBefore = sourceSink.calls.length;
    // status is source_written; reconcile would now look at the resume effect, not write_response
    const results = await outbox.reconcile();
    const writeAgain = sourceSink.calls.length;
    expect(writeAgain).toBe(callsBefore); // never re-wrote the source
    // it advanced toward resume instead (absent -> re-execute resume -> A4 lands
    // directly in terminal `resumed`) OR no-op
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(["source_written", "resume_requested", "resumed"]).toContain(row.status);
    expect(results).toBeDefined();
  });
});
