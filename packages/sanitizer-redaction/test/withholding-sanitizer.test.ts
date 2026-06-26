import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ProtectedStore, createWithholdingSanitizer, type Db } from "../src/index.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
// The protected_refs pointer table lives in the decision_index schema (created by
// the decision-index migration in production). sanitizer-redaction cannot depend on
// decision-index (circular), so spin up the schema+table directly for the test.
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
  const dir = mkdtempSync(join(tmpdir(), "pmws-"));
  const db = drizzle(client) as unknown as Db;
  return { store: new ProtectedStore({ key: KEY, dir, db }), dir, client };
}

describe("withholding sanitizer", () => {
  let ctx: Awaited<ReturnType<typeof makeStore>>;
  beforeEach(async () => {
    ctx = await makeStore();
  });
  afterEach(async () => {
    await ctx.client.close();
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
    expect(await ctx.store.get(w.ref)).toBe(JSON.stringify("secret"));
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

  it("rejects when input.subjectRef is missing or empty", async () => {
    const s = createWithholdingSanitizer({ fields: ["question"], store: ctx.store });
    await expect(s.sanitize({ content: { question: "x" } })).rejects.toThrow();
    await expect(s.sanitize({ content: { question: "x" }, subjectRef: "" })).rejects.toThrow();
  });
});
