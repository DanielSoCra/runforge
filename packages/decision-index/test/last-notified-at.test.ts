import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox } from "./helpers/effect-driver.js";
import { apply } from "../src/state-machine.js";
import { decisions } from "../src/schema.js";

async function notifiedAt(t: PgliteTestDb, id: string): Promise<string | null> {
  return (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!
    .last_notified_at;
}

/**
 * A9 — the index owns `last_notified_at` (the Notifier has no DB access). A
 * notify transition sets it; a re_notify advances it; a non-notify transition
 * (opened, write_response, ...) leaves it untouched.
 */
describe("last_notified_at set in the notify transition (A9)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("after a notify transition, last_notified_at is set", async () => {
    const id = await seedDecision(t.db); // last_notified_at null
    expect(await notifiedAt(t, id)).toBeNull();
    const f = makeOutbox(t);
    await f.outbox.runEffect(id, "notify"); // detected -> notified
    expect(await notifiedAt(t, id)).not.toBeNull();
  });

  it("re_notify ADVANCES last_notified_at", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    // notify at T1
    await apply(t.db, id, "notify", { semanticKey: "slack", now: "2026-05-27T00:00:01.000Z" });
    expect(await notifiedAt(t, id)).toBe("2026-05-27T00:00:01.000Z");
    // re_notify at T2 advances it
    await apply(t.db, id, "re_notify", { semanticKey: "cycle-1", now: "2026-05-27T00:05:00.000Z" });
    expect(await notifiedAt(t, id)).toBe("2026-05-27T00:05:00.000Z");
  });

  it("a non-notify transition (opened) leaves last_notified_at unchanged", async () => {
    const id = await seedDecision(t.db, { status: "notified" });
    // seed a known last_notified_at
    await t.db
      .update(decisions)
      .set({ last_notified_at: "2026-05-27T00:00:01.000Z" })
      .where(eq(decisions.decision_id, id));
    await apply(t.db, id, "opened", { semanticKey: "daniel", now: "2026-05-27T01:00:00.000Z" });
    expect(await notifiedAt(t, id)).toBe("2026-05-27T00:00:01.000Z");
  });

  it("the read model exposes last_notified_at", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await f.outbox.runEffect(id, "notify");
    const { ReadModel } = await import("../src/read-model.js");
    const view = (await new ReadModel(t.db).get(id))!;
    expect(view.last_notified_at).not.toBeNull();
  });
});
