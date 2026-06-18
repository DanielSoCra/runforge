import { describe, it, expect } from "vitest";
import { SanitizerConfigSchema, SanitizerBindingSchema } from "../src/index.js";

describe("SanitizerConfigSchema", () => {
  it("defaults to an empty array (no sanitization) when undefined", () => {
    expect(SanitizerConfigSchema.parse(undefined)).toEqual([]);
  });

  it("parses a list of bindings preserving order", () => {
    const cfg = SanitizerConfigSchema.parse([
      { plugin: "secret-scrubber" },
      { plugin: "pii", options: { locale: "de" } },
    ]);
    expect(cfg.map((b) => b.plugin)).toEqual(["secret-scrubber", "pii"]);
    expect(cfg[1]?.options).toEqual({ locale: "de" });
  });

  it("rejects a binding without a plugin name", () => {
    expect(() => SanitizerBindingSchema.parse({})).toThrow();
    expect(() => SanitizerBindingSchema.parse({ plugin: "" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => SanitizerBindingSchema.parse({ plugin: "a", bogus: 1 })).toThrow();
  });

  it("allows opaque options of any shape", () => {
    expect(() => SanitizerBindingSchema.parse({ plugin: "a", options: 42 })).not.toThrow();
    expect(() =>
      SanitizerBindingSchema.parse({ plugin: "a", options: { nested: { x: 1 } } }),
    ).not.toThrow();
  });
});
