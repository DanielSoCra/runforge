// GATE (immovable) — the withholding sanitizer's contract.
//
// CRITICAL CONTRACT (decisions schema): a withheld field's STORED VALUE must be the
// `protected://<ulid>` ref, because the decision read-model detects a protected field by
// `value.startsWith("protected://")` and resolves the class + reveal ref from that value.
// Storing a human marker would make the field read back as plain text — reveal impossible.
//
// Also pins:
//  - the sanitizer keys withheld material by input.subjectRef (not content.decision_id).
//  - IDEMPOTENT per (subjectRef, field): a retry reuses the existing ref (one row, one blob),
//    so the re-raised decision content is unchanged and storage is bounded.
//  - subjectRef is required ONLY when a field is actually withheld (pass-through never needs it).
//  - createWithholdingFactory(store) builds a sanitizer from {fields, marker?, class?}.
import { describe, it, expect } from "vitest";
import type { PutArgs, ProtectedStore } from "./protected-store.js";
import { createWithholdingSanitizer, createWithholdingFactory } from "./index.js";

/** A fake ProtectedStore: records puts, mints deterministic refs, supports findRefForField. */
function fakeStore() {
  const puts: PutArgs[] = [];
  const store = {
    put(args: PutArgs): string {
      puts.push(args);
      return `protected://fake-${puts.length}`;
    },
    findRefForField(decision_id: string, field: string): string | undefined {
      // newest-first, matching the real store (latest ref wins so edits converge).
      for (let i = puts.length - 1; i >= 0; i--) {
        if (puts[i]!.decision_id === decision_id && puts[i]!.field === field) {
          return `protected://fake-${i + 1}`;
        }
      }
      return undefined;
    },
    get(ref: string): string {
      return puts[Number(ref.split("-")[1]) - 1]!.plaintext;
    },
    responseHmac: (c: string) => `hmac:${c.length}`,
    verifyIntegrity: () => true as const,
  };
  return { store: store as unknown as ProtectedStore, puts };
}

describe("withholding sanitizer — protected-ref contract", () => {
  it("replaces a withheld field VALUE with the protected:// ref (read-model contract)", async () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });

    const result = await sanitizer.sanitize({ content: { secret: "S3CR3T", keep: "ok" }, subjectRef: "D-42" });

    // the STORED value is the ref, not a marker — so the read-model surfaces it as protected.
    expect(typeof result.content.secret).toBe("string");
    expect(result.content.secret as string).toMatch(/^protected:\/\//);
    expect(result.content.keep).toBe("ok");
    expect(result.content.decision_id).toBeUndefined();
    // the original is recoverable via that exact stored ref.
    expect(JSON.parse(await store.get(result.content.secret as string))).toBe("S3CR3T");
    // withholding record references the same ref; store keyed by subjectRef.
    expect(result.withholdings).toHaveLength(1);
    expect(result.withholdings[0]!.ref).toBe(result.content.secret);
    expect(puts[0]!.decision_id).toBe("D-42");
  });

  it("is idempotent per (subjectRef, field): a retry reuses the same ref, no duplicate put", async () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    const first = await sanitizer.sanitize({ content: { secret: "S" }, subjectRef: "D-1" });
    const second = await sanitizer.sanitize({ content: { secret: "S" }, subjectRef: "D-1" });
    expect(second.content.secret).toBe(first.content.secret); // same ref => raise sees unchanged
    expect(puts).toHaveLength(1); // stored once, not per retry
  });

  it("re-withholds an EDITED field (same subjectRef, changed value) with a fresh ref — no stale reuse", async () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    const a = await sanitizer.sanitize({ content: { secret: "A" }, subjectRef: "D-1" });
    const b = await sanitizer.sanitize({ content: { secret: "B" }, subjectRef: "D-1" }); // edited value
    expect(b.content.secret).not.toBe(a.content.secret); // new ref reflects the edit
    expect(puts).toHaveLength(2);
    expect(JSON.parse(await store.get(b.content.secret as string))).toBe("B");
    // a subsequent retry of the edited value reuses the latest ref (converges, no growth)
    const c = await sanitizer.sanitize({ content: { secret: "B" }, subjectRef: "D-1" });
    expect(c.content.secret).toBe(b.content.secret);
    expect(puts).toHaveLength(2);
  });

  it("passes content through unchanged (and needs no subjectRef) when no field is selected", async () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    const r = await sanitizer.sanitize({ content: { keep: "ok" } }); // no subjectRef — must NOT throw
    expect(r.content).toEqual({ keep: "ok" });
    expect(r.withholdings).toEqual([]);
    expect(puts).toHaveLength(0);
  });

  it("fails closed when a configured field is not a string (e.g. a structured options array)", async () => {
    const { store } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["options"], store });
    await expect(
      sanitizer.sanitize({ content: { options: [{ id: "a" }] }, subjectRef: "D-1" }),
    ).rejects.toThrow();
  });

  it("fails closed when a field must be withheld but no subjectRef is supplied", async () => {
    const { store } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    await expect(sanitizer.sanitize({ content: { secret: "S" } })).rejects.toThrow();
    await expect(sanitizer.sanitize({ content: { secret: "S" }, subjectRef: "" })).rejects.toThrow();
  });
});

describe("createWithholdingFactory — per-binding options", () => {
  it("builds a sanitizer that stores a protected:// ref, keyed by subjectRef", async () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingFactory(store)({ fields: ["context"], class: "secret" });
    expect(sanitizer.name).toBe("withholding");
    const r = await sanitizer.sanitize({ content: { context: "c" }, subjectRef: "D-7" });
    expect(r.content.context as string).toMatch(/^protected:\/\//);
    expect(puts[0]!.decision_id).toBe("D-7");
    expect(puts[0]!.class).toBe("secret");
  });

  it("rejects options without a non-empty fields array", () => {
    const { store } = fakeStore();
    const factory = createWithholdingFactory(store);
    expect(() => factory({})).toThrow();
    expect(() => factory({ fields: [] })).toThrow();
    expect(() => factory({ fields: "context" })).toThrow();
  });
});
