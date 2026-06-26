import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, FIXED_NOW } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable, appliedTransitions } from "../src/schema.js";

/**
 * IMPORTANT I6 — re_notify crash recovery. A reserved `re_notify:<cycle>` outbox
 * row whose notify was already sent at the channel, but whose commit txn never
 * ran (crash before commit), must be reconciled: probe the notify id, find it
 * applied, commit (idempotent), leave NO stuck reserved row and the correct
 * status. The prior code excluded notify rows from the reserved-row reconcile
 * path AND expectedEffect() did not expect notify from `notified`/`viewed`.
 */
describe("re_notify crash recovery (Finding I6)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("reserved re_notify row + sent-before-commit -> reconcile resolves it (committed, no stuck reserved row)", async () => {
    const id = await seedDecision(t.db, { status: "notified" });
    const f = makeOutbox(t);

    // the re_notify cycle's deterministic id (kind=notify, idKey=channel:cycle)
    const reNotifyId = await f.outbox.effectIdFor(id, "notify", { reNotifyCycle: "cycle-7" });
    expect(reNotifyId).toContain("cycle-7"); // id encodes the cycle

    // crash state: re_notify reserved, notify ALREADY sent at the channel, but
    // commit never ran (row still `reserved`, no applied_transition).
    await t.db
      .insert(outboxTable)
      .values({
        id: reNotifyId,
        decision_id: id,
        kind: "notify",
        intended_transition: "re_notify",
        semantic_key: "cycle-7", // what reserve() persists (Finding I6)
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    f.notifier.applied.add(reNotifyId); // already sent at the channel

    const callsBefore = f.notifier.calls.length; // 0 — nothing re-sent yet
    const results = await f.outbox.reconcile();

    // resolved, not re-sent
    expect(f.notifier.calls.length).toBe(callsBefore);
    const mine = results.find((x) => x.decision_id === id)!;
    expect(mine).toBeDefined();
    expect(mine.kind).toBe("notify");
    expect(mine.action).toBe("advanced");

    // re_notify keeps the item in `notified`; the row is now committed (no stuck reserve)
    const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
    expect(row.status).toBe("notified");
    const obRow = (await t.db.select().from(outboxTable).where(eq(outboxTable.id, reNotifyId)))[0]!;
    expect(obRow.state).toBe("committed");

    // the re_notify:<cycle> transition was applied (correct semantic key, not notify:<channel>)
    const keys = (await t.db
      .select()
      .from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keys).toContain("re_notify:cycle-7");

    // no stuck reserved rows remain
    const stuck = (await t.db
      .select()
      .from(outboxTable))
      .filter((o) => o.decision_id === id && o.state === "reserved");
    expect(stuck).toHaveLength(0);
  });

  it("re_notify cycle is an ISO-8601 timestamp CONTAINING ':' -> recovered cycle is the FULL token, second reconcile is a no-op (Finding I6 residual)", async () => {
    // Residual I6: specFromRow recovered the cycle as the LAST ':'-delimited
    // segment of the id. An ISO timestamp cycle (e.g. 2026-05-27T23:30:00Z)
    // contains ':' so the recovered cycle was truncated to "00Z", producing the
    // WRONG transition key and allowing a duplicate re-notify. The cycle must be
    // recovered from a dedicated semantic_key column, never by string-splitting.
    const CYCLE = "2026-05-27T23:30:00Z";
    const id = await seedDecision(t.db, { status: "notified" });
    const f = makeOutbox(t);

    const reNotifyId = await f.outbox.effectIdFor(id, "notify", { reNotifyCycle: CYCLE });
    expect(reNotifyId).toContain(CYCLE); // id encodes the full cycle

    // crash state: re_notify reserved, notify ALREADY sent, commit never ran.
    await t.db
      .insert(outboxTable)
      .values({
        id: reNotifyId,
        decision_id: id,
        kind: "notify",
        intended_transition: "re_notify",
        semantic_key: CYCLE,
        state: "reserved",
        attempts: 0,
        created_at: FIXED_NOW,
      });
    f.notifier.applied.add(reNotifyId);

    const callsBefore = f.notifier.calls.length;
    await f.outbox.reconcile();
    expect(f.notifier.calls.length).toBe(callsBefore); // not re-sent

    // the committed applied-transition key is EXACTLY re_notify:<full-cycle>
    const keys = (await t.db
      .select()
      .from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keys).toContain(`re_notify:${CYCLE}`);
    // and NOT a truncated suffix
    expect(keys).not.toContain("re_notify:00Z");

    // second reconcile is a no-op: no duplicate dispatch, no new applied row
    const callsBeforeSecond = f.notifier.calls.length;
    await f.outbox.reconcile();
    expect(f.notifier.calls.length).toBe(callsBeforeSecond);
    const keysAfter = (await t.db
      .select()
      .from(appliedTransitions))
      .filter((k) => k.decision_id === id)
      .map((k) => k.transition_key);
    expect(keysAfter.filter((k) => k === `re_notify:${CYCLE}`)).toHaveLength(1);
  });
});
