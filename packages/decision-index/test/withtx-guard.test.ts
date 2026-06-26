import { describe, it, expect, afterEach } from "vitest";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { withTx } from "../src/db.js";
import { quarantineEvents } from "../src/schema.js";

/**
 * Task 5 — the re-entrant guarded writer primitive (spec §3.5 + §3.4 layer 2).
 * PGlite is a single in-process session; these tests pin re-entrancy (no
 * deadlock, one transaction) and rollback atomicity. The cross-process advisory
 * lock proof lives in the real-Postgres integration suite (Task 12).
 */
describe("withTx (re-entrant guarded writer)", () => {
  let t: PgliteTestDb;
  afterEach(async () => {
    await t?.cleanup();
  });

  async function reasons(): Promise<string[]> {
    const rows = await t.db.select().from(quarantineEvents);
    return rows.map((r) => r.reason);
  }

  it("nested withTx does not deadlock and both writes land in one committed tx", async () => {
    t = await makePgliteDb();
    const now = new Date().toISOString();

    await withTx(t.db, async (t1) => {
      await t1.insert(quarantineEvents).values({ reason: "outer", created_at: now });
      // Re-entrant call passing the open tx — must REUSE it, not block on the mutex.
      await withTx(t1, async (t2) => {
        await t2.insert(quarantineEvents).values({ reason: "inner", created_at: now });
      });
    });

    const r = await reasons();
    expect(r).toContain("outer");
    expect(r).toContain("inner");
  });

  it("a throw rolls back the whole tx including the nested write (no partial write)", async () => {
    t = await makePgliteDb();
    const now = new Date().toISOString();

    await expect(
      withTx(t.db, async (t1) => {
        await t1.insert(quarantineEvents).values({ reason: "willRollback", created_at: now });
        await withTx(t1, async (t2) => {
          await t2.insert(quarantineEvents).values({ reason: "alsoRollback", created_at: now });
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const r = await reasons();
    expect(r).not.toContain("willRollback");
    expect(r).not.toContain("alsoRollback");
  });

  it("serializes sequential top-level writes (mutex) and commits each", async () => {
    t = await makePgliteDb();
    const now = new Date().toISOString();

    await Promise.all([
      withTx(t.db, async (tx) => {
        await tx.insert(quarantineEvents).values({ reason: "a", created_at: now });
      }),
      withTx(t.db, async (tx) => {
        await tx.insert(quarantineEvents).values({ reason: "b", created_at: now });
      }),
    ]);

    const r = await reasons();
    expect(r.sort()).toEqual(["a", "b"]);
  });
});
