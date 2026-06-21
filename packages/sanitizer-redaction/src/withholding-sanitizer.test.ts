// GATE (immovable): the withholding sanitizer's contract with the ProtectedStore.
//
// 5a activation rules this pins:
//  - the sanitizer keys withheld material by input.subjectRef (the opaque subject id),
//    NOT by a content.decision_id field — metadata must never live inside sanitizable content.
//  - a field selected for withholding is replaced by the marker; non-selected fields pass through.
//  - withholdings carry the store ref (for authorized reveal), never the plaintext.
//  - if a field would be withheld but no subjectRef is supplied, it fails closed (throws).
//  - createWithholdingFactory(store) builds a sanitizer from per-binding options {fields, marker?, class?}.
import { describe, it, expect } from "vitest";
import type { PutArgs } from "./protected-store.js";
import { createWithholdingSanitizer, createWithholdingFactory } from "./index.js";

/** A fake ProtectedStore that records put() calls and mints deterministic refs. */
function fakeStore() {
  const puts: PutArgs[] = [];
  const store = {
    put(args: PutArgs): string {
      puts.push(args);
      return `protected://fake-${puts.length}`;
    },
    get(ref: string): string {
      const idx = Number(ref.split("-")[1]) - 1;
      return puts[idx]!.plaintext;
    },
    responseHmac(canonical: string): string {
      return `hmac:${canonical.length}`;
    },
    verifyIntegrity(): true {
      return true;
    },
  };
  return { store: store as unknown as import("./protected-store.js").ProtectedStore, puts };
}

describe("withholding sanitizer — subjectRef keying", () => {
  it("withholds selected fields, keyed by input.subjectRef (not content.decision_id)", () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store, marker: "[X]" });

    const result = sanitizer.sanitize({
      content: { secret: "S3CR3T", keep: "ok" },
      subjectRef: "D-42",
    });

    expect(result.content.secret).toBe("[X]");
    expect(result.content.keep).toBe("ok");
    // metadata stayed out of content — no decision_id key required or emitted.
    expect(result.content.decision_id).toBeUndefined();
    expect(result.withholdings).toEqual([
      { field: "secret", marker: "[X]", ref: "protected://fake-1" },
    ]);
    // the store was keyed by the subjectRef.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.decision_id).toBe("D-42");
    expect(puts[0]!.field).toBe("secret");
    expect(JSON.parse(puts[0]!.plaintext)).toBe("S3CR3T");
  });

  it("passes content through unchanged when no selected field is present", () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    const result = sanitizer.sanitize({ content: { keep: "ok" }, subjectRef: "D-1" });
    expect(result.content).toEqual({ keep: "ok" });
    expect(result.withholdings).toEqual([]);
    expect(puts).toHaveLength(0);
  });

  it("fails closed when a field must be withheld but no subjectRef is supplied", () => {
    const { store } = fakeStore();
    const sanitizer = createWithholdingSanitizer({ fields: ["secret"], store });
    expect(() => sanitizer.sanitize({ content: { secret: "S" } })).toThrow();
  });
});

describe("createWithholdingFactory — per-binding options", () => {
  it("builds a sanitizer from {fields} options", () => {
    const { store, puts } = fakeStore();
    const factory = createWithholdingFactory(store);
    const sanitizer = factory({ fields: ["context"] });
    expect(sanitizer.name).toBe("withholding");
    const r = sanitizer.sanitize({ content: { context: "c" }, subjectRef: "D-7" });
    expect(r.content.context).toBe("[WITHHELD]");
    expect(puts[0]!.decision_id).toBe("D-7");
  });

  it("honors a custom marker and class from options", () => {
    const { store, puts } = fakeStore();
    const sanitizer = createWithholdingFactory(store)({
      fields: ["context"],
      marker: "[hidden]",
      class: "secret",
    });
    const r = sanitizer.sanitize({ content: { context: "c" }, subjectRef: "D-8" });
    expect(r.content.context).toBe("[hidden]");
    expect(puts[0]!.class).toBe("secret");
  });

  it("rejects options that do not specify a non-empty fields array", () => {
    const { store } = fakeStore();
    const factory = createWithholdingFactory(store);
    expect(() => factory({})).toThrow();
    expect(() => factory({ fields: [] })).toThrow();
    expect(() => factory({ fields: "context" })).toThrow();
  });
});
