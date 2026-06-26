import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable, appliedTransitions } from "../src/schema.js";

/**
 * Crash-BEFORE-execute recovery (two-phase invariant). A reserved notify /
 * re_notify outbox row whose effect was reserved (step 1) but NEVER executed
 * before the crash probes `absent`. The reserved row is itself the durable
 * evidence the effect was intended, so reconcile MUST run step 2 (execute) then
 * commit it — even though state-derived expectedEffect() returns null for the
 * `notified` status and would otherwise leave the row stuck in `reserved`.
 */
describe("absent reserved effect recovery (crash before execute)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("reserved re_notify row + crash before execute (absent) -> reconcile executes + commits, no stuck reserved, idempotent", async () => {
    const id = await seedDecision(t.db, { status: "notified" });
    const f = makeOutbox(t);

    const reNotifyId = await f.outbox.effectIdFor(id, "notify", { reNotifyCycle: "cycle-9" });
    expect(reNotifyId).toContain("cycle-9");

    // crash state: re_notify reserved, but the Notifier NEVER sent (probe -> absent).
    await t.db
      .insert(outboxTable)
      .values({
        id: reNotifyId,
        decision_id: id,
        kind: "notify",
        intended_transition: "re_notify",
        semantic_key: "cycle-9",
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    // NOTE: notifier.applied is empty -> probe(reNotifyId) === "absent"

    expect(await f.notifier.probe(reNotifyId)).toBe("absent");
    const callsBefore = f.notifier.calls.length; // 0

    const results = await f.outbox.reconcile();

    // step 2 ran exactly once: the notify was executed
    expect(f.notifier.calls.length).toBe(callsBefore + 1);
    expect(f.notifier.calls[f.notifier.calls.length - 1].effectId).toBe(reNotifyId);

    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine).toBeDefined();
    expect(mine.kind).toBe("notify");

    // row committed, no stuck reserved row
    const obRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, reNotifyId)))[0]!;
    expect(obRow.state).toBe("committed");

    const stuck = (await t.db.select().from(outboxTable)).filter(
      (o) => o.decision_id === id && o.state === "reserved",
    );
    expect(stuck).toHaveLength(0);

    // the re_notify:<cycle> transition was recorded (correct semantic key)
    const keys = (await t.db.select().from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keys).toContain("re_notify:cycle-9");

    // item stays in notified after a re_notify
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("notified");

    // second reconcile is a no-op: no re-send, no duplicate applied row
    const callsBeforeSecond = f.notifier.calls.length;
    await f.outbox.reconcile();
    expect(f.notifier.calls.length).toBe(callsBeforeSecond);
    const keysAfter = (await t.db.select().from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keysAfter.filter((k) => k === "re_notify:cycle-9")).toHaveLength(1);
  });

  it("reserved initial notify row + crash before execute (absent) -> reconcile executes + commits", async () => {
    const id = await seedDecision(t.db, { status: "detected" });
    const f = makeOutbox(t);

    const notifyId = await f.outbox.effectIdFor(id, "notify");

    // crash state: initial notify reserved, never sent (probe -> absent).
    await t.db
      .insert(outboxTable)
      .values({
        id: notifyId,
        decision_id: id,
        kind: "notify",
        intended_transition: "notify",
        semantic_key: "slack",
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });

    expect(await f.notifier.probe(notifyId)).toBe("absent");
    const callsBefore = f.notifier.calls.length;

    await f.outbox.reconcile();

    expect(f.notifier.calls.length).toBe(callsBefore + 1);
    const obRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, notifyId)))[0]!;
    expect(obRow.state).toBe("committed");

    const stuck = (await t.db.select().from(outboxTable)).filter(
      (o) => o.decision_id === id && o.state === "reserved",
    );
    expect(stuck).toHaveLength(0);

    const keys = (await t.db.select().from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keys).toContain("notify:slack");

    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("notified");
  });
});
