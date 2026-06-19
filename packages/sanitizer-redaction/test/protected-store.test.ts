import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ProtectedStore, ProtectedIntegrityError } from "../src/index.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const CREATE_REFS =
  "CREATE TABLE protected_refs (ulid TEXT PRIMARY KEY, decision_id TEXT, field TEXT NOT NULL, class TEXT NOT NULL, created_at TEXT NOT NULL);";

function makeStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_REFS);
  const dir = mkdtempSync(join(tmpdir(), "pmps-"));
  return { store: new ProtectedStore({ key: KEY, dir, db: drizzle(sqlite) }), dir, sqlite };
}

describe("ProtectedStore", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });
  afterEach(() => {
    ctx.sqlite.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("rejects a key that does not decode to 32 bytes", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_REFS);
    expect(
      () => new ProtectedStore({ key: "tooshort", dir: ctx.dir, db: drizzle(sqlite) }),
    ).toThrow();
  });

  it("round-trips plaintext through put → get", () => {
    const ref = ctx.store.put({ decision_id: "d1", field: "question", class: "withheld", plaintext: "secret value" });
    expect(ref).toMatch(/^protected:\/\//);
    expect(ctx.store.get(ref)).toBe("secret value");
  });

  it("verifyIntegrity passes for a stored ref", () => {
    const ref = ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    expect(ctx.store.verifyIntegrity(ref)).toBe(true);
  });

  it("distinct puts yield distinct refs", () => {
    const a = ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    const b = ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "x" });
    expect(a).not.toBe(b);
  });

  it("rejects a non-protected ref", () => {
    expect(() => ctx.store.get("not-a-ref")).toThrow(ProtectedIntegrityError);
  });

  it("never writes plaintext to the on-disk blob (encrypted at rest)", () => {
    const ref = ctx.store.put({ decision_id: "d1", field: "f", class: "withheld", plaintext: "TOPSECRET-NEEDLE" });
    expect(ctx.store.get(ref)).toBe("TOPSECRET-NEEDLE");
    for (const f of readdirSync(ctx.dir)) {
      const bytes = readFileSync(join(ctx.dir, f)).toString("latin1");
      expect(bytes.includes("TOPSECRET-NEEDLE"), `${f} leaks plaintext`).toBe(false);
    }
  });
});
