import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ProtectedStore, createWithholdingSanitizer } from "../src/index.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const CREATE_REFS =
  "CREATE TABLE protected_refs (ulid TEXT PRIMARY KEY, decision_id TEXT, field TEXT NOT NULL, class TEXT NOT NULL, created_at TEXT NOT NULL);";

function makeStore() {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_REFS);
  const dir = mkdtempSync(join(tmpdir(), "pmws-"));
  return { store: new ProtectedStore({ key: KEY, dir, db: drizzle(sqlite) }), dir, sqlite };
}

describe("withholding sanitizer", () => {
  let ctx: ReturnType<typeof makeStore>;
  beforeEach(() => {
    ctx = makeStore();
  });
  afterEach(() => {
    ctx.sqlite.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("withholds configured fields into the protected store, leaving other content intact", async () => {
    const s = createWithholdingSanitizer({ fields: ["question"], store: ctx.store });
    expect(s.name).toBe("withholding");
    const r = await s.sanitize({ content: { question: "secret", context: "keep" }, subjectRef: "d1" });
    expect(r.content.context).toBe("keep");
    // withheld field's VALUE becomes the protected:// ref (read-model contract), not a marker.
    expect(r.content.question as string).toMatch(/^protected:\/\//);
    expect(r.withholdings).toHaveLength(1);
    const w = r.withholdings[0]!;
    expect(w.field).toBe("question");
    expect(w.ref).toBe(r.content.question);
    expect(ctx.store.get(w.ref)).toBe(JSON.stringify("secret"));
  });

  it("uses a custom marker", async () => {
    const s = createWithholdingSanitizer({ fields: ["question"], marker: "[redacted]", store: ctx.store });
    const r = await s.sanitize({ content: { question: "x" }, subjectRef: "d1" });
    expect(r.withholdings[0]!.marker).toBe("[redacted]");
  });

  it("emits no withholdings when no configured field is present", async () => {
    const s = createWithholdingSanitizer({ fields: ["ssn"], store: ctx.store });
    const r = await s.sanitize({ content: { question: "x" }, subjectRef: "d1" });
    expect(r.withholdings).toEqual([]);
    expect(r.content).toEqual({ question: "x" });
  });

  it("throws when input.subjectRef is missing or empty", () => {
    const s = createWithholdingSanitizer({ fields: ["question"], store: ctx.store });
    expect(() => s.sanitize({ content: { question: "x" } })).toThrow();
    expect(() => s.sanitize({ content: { question: "x" }, subjectRef: "" })).toThrow();
  });
});
