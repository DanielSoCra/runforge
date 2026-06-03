import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTempDb, type TempDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox } from "./helpers/effect-driver.js";
import { apply } from "../src/state-machine.js";
import { decisions } from "../src/schema.js";

function notifiedAt(t: TempDb, id: string): string | null {
  return t.db.select().from(decisions).where(eq(decisions.decision_id, id)).all()[0]!.last_notified_at;
}

/**
 * A9 — the index owns `last_notified_at` (the Notifier has no DB access). A
 * notify transition sets it; a re_notify advances it; a non-notify transition
 * (opened, write_response, ...) leaves it untouched.
 */
describe("last_notified_at set in the notify transition (A9)", () => {
  let t: TempDb;
  beforeEach(() => (t = makeTempDb()));
  afterEach(() => t?.cleanup());

  it("after a notify transition, last_notified_at is set", async () => {
    const id = seedDecision(t.db); // last_notified_at null
    expect(notifiedAt(t, id)).toBeNull();
    const f = makeOutbox(t);
    await f.outbox.runEffect(id, "notify"); // detected -> notified
    expect(notifiedAt(t, id)).not.toBeNull();
  });

  it("re_notify ADVANCES last_notified_at", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    // notify at T1
    apply(t.db, id, "notify", { semanticKey: "slack", now: "2026-05-27T00:00:01.000Z" });
    expect(notifiedAt(t, id)).toBe("2026-05-27T00:00:01.000Z");
    // re_notify at T2 advances it
    apply(t.db, id, "re_notify", { semanticKey: "cycle-1", now: "2026-05-27T00:05:00.000Z" });
    expect(notifiedAt(t, id)).toBe("2026-05-27T00:05:00.000Z");
  });

  it("a non-notify transition (opened) leaves last_notified_at unchanged", () => {
    const id = seedDecision(t.db, { status: "notified" });
    // seed a known last_notified_at
    t.db
      .update(decisions)
      .set({ last_notified_at: "2026-05-27T00:00:01.000Z" })
      .where(eq(decisions.decision_id, id))
      .run();
    apply(t.db, id, "opened", { semanticKey: "daniel", now: "2026-05-27T01:00:00.000Z" });
    expect(notifiedAt(t, id)).toBe("2026-05-27T00:00:01.000Z");
  });

  it("the read model exposes last_notified_at", async () => {
    const id = seedDecision(t.db);
    const f = makeOutbox(t);
    await f.outbox.runEffect(id, "notify");
    const { ReadModel } = await import("../src/read-model.js");
    const view = new ReadModel(t.db).get(id)!;
    expect(view.last_notified_at).not.toBeNull();
  });
});
