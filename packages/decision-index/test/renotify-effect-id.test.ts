import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox } from "./helpers/effect-driver.js";
import { outbox as outboxTable, appliedTransitions } from "../src/schema.js";

/**
 * IMPORTANT 6 — re_notify must carry its OWN intended transition + semantic key,
 * NOT a hardcoded `notify`/`<channel>`. Two distinct notify cycles must produce
 * two distinct deterministic effect ids AND two distinct applied transitions
 * (`notify:<channel>` then `re_notify:<cycle>`), not collapse to one.
 */
describe("re_notify deterministic effect id + intended transition (Finding 6)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("two notify cycles produce two DISTINCT deterministic effect ids", async () => {
    const id = await seedDecision(t.db); // detected
    const f = makeOutbox(t);

    // cycle 0: the initial notify (detected -> notified)
    const r0 = await f.outbox.runEffect(id, "notify");
    expect(r0.outcome).toBe("committed");

    // cycle 1: a re_notify re-surface from `notified`
    const r1 = await f.outbox.runEffect(id, "notify", { reNotifyCycle: "cycle-1" });
    expect(r1.outcome).toBe("committed");

    const rows = (await t.db.select().from(outboxTable)).filter(
      (o) => o.decision_id === id && o.kind === "notify",
    );
    const ids = new Set(rows.map((o) => o.id));
    expect(ids.size).toBe(2); // two distinct outbox ids, not one collapsed id

    // and the intended transitions differ: notify vs re_notify
    const intended = rows.map((o) => o.intended_transition).sort();
    expect(intended).toEqual(["notify", "re_notify"]);

    // two distinct applied_transitions keys: notify:slack and re_notify:cycle-1
    const keys = (await t.db.select().from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keys).toContain("notify:slack");
    expect(keys).toContain("re_notify:cycle-1");
  });

  it("a second re_notify with a NEW cycle is again distinct (not idempotent against the first)", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await f.outbox.runEffect(id, "notify");
    await f.outbox.runEffect(id, "notify", { reNotifyCycle: "cycle-1" });
    await f.outbox.runEffect(id, "notify", { reNotifyCycle: "cycle-2" });

    const keys = (await t.db.select().from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key)
      .filter((k) => k.startsWith("re_notify:"));
    expect(new Set(keys)).toEqual(new Set(["re_notify:cycle-1", "re_notify:cycle-2"]));
  });
});
