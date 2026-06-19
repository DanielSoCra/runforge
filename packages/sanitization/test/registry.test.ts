import { describe, it, expect } from "vitest";
import { SanitizerRegistry, UnknownSanitizerError, SanitizationPipeline } from "../src/index.js";
import type { Sanitizer } from "../src/index.js";

const fakeFactory = (name: string) => (options: unknown): Sanitizer => ({
  name,
  sanitize: (i) => ({ content: { ...i.content, [`by-${name}`]: options ?? true }, withholdings: [] }),
});

describe("SanitizerRegistry", () => {
  it("builds an empty (identity) pipeline from no bindings", () => {
    const p = new SanitizerRegistry().build([]);
    expect(p).toBeInstanceOf(SanitizationPipeline);
    expect(p.isEmpty).toBe(true);
  });

  it("resolves factories by plugin name in binding order", async () => {
    const reg = new SanitizerRegistry();
    reg.register("a", fakeFactory("a"));
    reg.register("b", fakeFactory("b"));
    const r = await reg.build([{ plugin: "b" }, { plugin: "a" }]).run({ content: {} });
    expect(Object.keys(r.content)).toEqual(["by-b", "by-a"]);
  });

  it("passes binding options to the factory", async () => {
    const reg = new SanitizerRegistry();
    reg.register("a", fakeFactory("a"));
    const r = await reg.build([{ plugin: "a", options: { k: 1 } }]).run({ content: {} });
    expect(r.content["by-a"]).toEqual({ k: 1 });
  });

  it("throws UnknownSanitizerError for an unregistered plugin", () => {
    const reg = new SanitizerRegistry();
    expect(() => reg.build([{ plugin: "missing" }])).toThrow(UnknownSanitizerError);
  });

  it("throws on duplicate registration", () => {
    const reg = new SanitizerRegistry();
    reg.register("a", fakeFactory("a"));
    expect(() => reg.register("a", fakeFactory("a"))).toThrow();
  });

  it("has() reflects registration", () => {
    const reg = new SanitizerRegistry();
    expect(reg.has("a")).toBe(false);
    reg.register("a", fakeFactory("a"));
    expect(reg.has("a")).toBe(true);
  });

  it("catalog() lists registered sanitizer names", () => {
    const reg = new SanitizerRegistry();
    reg.register("a", fakeFactory("a"));
    reg.register("b", fakeFactory("b"));
    expect(
      reg
        .catalog()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("catalog() carries an optional description from registration", () => {
    const reg = new SanitizerRegistry();
    reg.register("a", fakeFactory("a"), "recognizes secrets");
    expect(reg.catalog().find((c) => c.name === "a")?.description).toBe("recognizes secrets");
  });
});
