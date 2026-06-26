import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, FIXED_NOW } from "./helpers/effect-driver.js";
import { outbox as outboxTable } from "../src/schema.js";

/**
 * Task 6 (spec §3.4) — the CAS claim decides the winner by the affected-row COUNT
 * of a single atomic `UPDATE ... WHERE state='reserved' RETURNING`, NOT by a
 * read-before/read-after (which is unsound on concurrent Postgres under READ
 * COMMITTED). Two overlapping claims of the same reserved row: exactly one wins;
 * the loser sees the row already `executing` and returns false.
 */
describe("CAS rowCount claim (Task 6)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("two overlapping claim(id) calls: exactly one wins; the loser observes executing", async () => {
    const id = await seedDecision(t.db, { resume_mode: "requeue" });
    const f = makeOutbox(t);
    // The `claim` method is private; access it through a typed escape hatch — the
    // focused unit under test is the rowCount CAS, not the public surface.
    const outbox = f.outbox as unknown as {
      claim(id: string): Promise<boolean>;
    };

    const effId = `${id}:notify:slack`;
    await t.db.insert(outboxTable).values({
      id: effId,
      decision_id: id,
      kind: "notify",
      intended_transition: "notify",
      semantic_key: "slack",
      payload_ref: null,
      state: "reserved",
      superseded: false,
      attempts: 0,
      created_at: FIXED_NOW,
    });

    const [a, b] = await Promise.all([outbox.claim(effId), outbox.claim(effId)]);

    // Exactly one claim won.
    expect([a, b].filter(Boolean)).toHaveLength(1);

    // The row is now `executing` (the winner flipped it); the loser saw 0 rows.
    const row = (
      await t.db.select().from(outboxTable).where(eq(outboxTable.id, effId))
    )[0]!;
    expect(row.state).toBe("executing");

    // A third claim on the now-executing row must also lose (not reserved).
    expect(await outbox.claim(effId)).toBe(false);
  });
});
