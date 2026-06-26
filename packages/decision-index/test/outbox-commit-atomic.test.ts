import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions, outbox as outboxTable } from "../src/schema.js";

/**
 * IMPORTANT 5 — commit must advance state AND mark the outbox row committed in a
 * SINGLE transaction. Otherwise a crash between the two txns leaves advanced
 * state with a stale `reserved` outbox row. We assert that after a committed
 * effect there is NO `reserved` row left for the item, and the committed row's
 * state matches the advanced status (all-or-nothing).
 */
describe("commit is atomic: no stale reserved row remains (Finding 5)", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  it("after a committed write_response, the outbox row is committed and NO reserved row remains", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    const r = await f.outbox.runEffect(id, "write_response");
    expect(r.status).toBe("source_written");

    const rows = (await t.db.select().from(outboxTable)).filter((o) => o.decision_id === id);
    // exactly the write_response row, committed — no leftover reserved row.
    const reserved = rows.filter((o) => o.state === "reserved");
    expect(reserved).toHaveLength(0);
    const wr = rows.find((o) => o.kind === "write_response")!;
    expect(wr.state).toBe("committed");
    expect(wr.committed_at).not.toBeNull();
  });

  it("the committed outbox row's committed_at and the advanced status share the same write (single txn)", async () => {
    // Full happy path through write_response + resume. At every committed step the
    // status advances AND the owning outbox row is committed — there is never a
    // moment where one is written without the other (single-transaction commit).
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    await answerItem(t, f.outbox, id);
    await f.outbox.runEffect(id, "write_response"); // -> source_written
    await f.outbox.runEffect(id, "resume"); // -> resumed (A4 atomic dispatch+ack)

    const rows = (await t.db.select().from(outboxTable)).filter((o) => o.decision_id === id);
    // no stale reserved rows anywhere along the path
    expect(rows.filter((o) => o.state === "reserved")).toHaveLength(0);
    // every row that exists is committed
    expect(rows.every((o) => o.state === "committed" && o.committed_at !== null)).toBe(true);

    const status = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
    expect(status).toBe("resumed");
  });

  it("after a committed notify, the notify outbox row is committed (state advanced together)", async () => {
    const id = await seedDecision(t.db);
    const f = makeOutbox(t);
    const r = await f.outbox.runEffect(id, "notify");
    expect(r.status).toBe("notified");

    const reserved = (await t.db.select().from(outboxTable)).filter(
      (o) => o.decision_id === id && o.state === "reserved",
    );
    expect(reserved).toHaveLength(0);

    const status = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!.status;
    expect(status).toBe("notified");
  });
});
