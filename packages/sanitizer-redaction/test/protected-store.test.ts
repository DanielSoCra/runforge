import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ProtectedStore, ProtectedIntegrityError, type Db } from "../src/index.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
// protected_refs lives in the decision_index schema (created by the decision-index
// migration in prod); create it directly here (no cross-package dep).
const CREATE_REFS = `
  CREATE SCHEMA IF NOT EXISTS decision_index;
  CREATE TABLE decision_index.protected_refs (
    ulid text PRIMARY KEY,
    decision_id text,
    field text NOT NULL,
    class text NOT NULL,
    created_at text NOT NULL
  );`;

async function makeStore() {
  const client = new PGlite();
  await client.exec(CREATE_REFS);
  const dir = mkdtempSync(join(tmpdir(), "pmps-"));
  const db = drizzle(client) as unknown as Db;
  return { store: new ProtectedStore({ key: KEY, dir, db }), dir, client };
}

describe("ProtectedStore", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;
  beforeEach(async () => {
    ctx = await makeStore();
  });
  afterEach(async () => {
    await ctx.client.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    // The constructor validates the key synchronously, before it ever touches db.
    expect(
      () => new ProtectedStore({ key: "tooshort", dir: ctx.dir, db: {} as Db }),
    ).toThrow();
  });

  it("round-trips plaintext through put → get", async () => {
    const ref = await ctx.store.put({ decision_id: "d1", field: "question", class: "withheld", plaintext: "secret value" });
    expect(ref).toMatch(/^protected:\/\//);
    expect(await ctx.store.get(ref)).toBe("secret value");
  });

  it("verifyIntegrity passes for a stored ref", async () => {
    const ref = await ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    expect(await ctx.store.verifyIntegrity(ref)).toBe(true);
  });

  it("distinct puts yield distinct refs", async () => {
    const a = await ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    const b = await ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    expect(a).not.toBe(b);
  });

  it("rejects a non-protected ref", async () => {
    await expect(ctx.store.get("not-a-ref")).rejects.toThrow(ProtectedIntegrityError);
  });

  it("never writes plaintext to the on-disk blob (encrypted at rest)", async () => {
    const ref = await ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "TOPSECRET-NEEDLE" });
    expect(await ctx.store.get(ref)).toBe("TOPSECRET-NEEDLE");
    for (const f of readdirSync(ctx.dir)) {
      const bytes = readFileSync(join(ctx.dir, f)).toString("latin1");
      expect(bytes.includes("TOPSECRET-NEEDLE"), `${f} leaks plaintext`).toBe(false);
    }
  });
});
