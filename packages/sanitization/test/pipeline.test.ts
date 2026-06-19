import { describe, it, expect } from "vitest";
import { SanitizationPipeline } from "../src/index.js";
import type { Sanitizer, SanitizationResult } from "../src/index.js";

const passthrough = (content: Record<string, unknown>): SanitizationResult => ({
  content,
  withholdings: [],
});

describe("SanitizationPipeline", () => {
  it("empty pipeline is the identity (content unchanged, no withholdings)", async () => {
    const content = { question: "hi", context: "there" };
    const r = await new SanitizationPipeline([]).run({ content });
    expect(r.content).toEqual({ question: "hi", context: "there" });
    expect(r.withholdings).toEqual([]);
  });

  it("reports isEmpty", () => {
    expect(new SanitizationPipeline([]).isEmpty).toBe(true);
    const s: Sanitizer = { name: "x", sanitize: (i) => passthrough(i.content) };
    expect(new SanitizationPipeline([s]).isEmpty).toBe(false);
  });

  it("does not mutate the caller's content object", async () => {
    const redact: Sanitizer = {
      name: "redact",
      sanitize: (i) => ({
        content: { ...i.content, question: "[withheld]" },
        withholdings: [{ field: "question", marker: "[withheld]", ref: "ref-1" }],
      }),
    };
    const content = { question: "secret", context: "ctx" };
    await new SanitizationPipeline([redact]).run({ content });
    expect(content).toEqual({ question: "secret", context: "ctx" });
  });

  it("applies a single sanitizer's transform and withholding", async () => {
    const s: Sanitizer = {
      name: "s",
      sanitize: (i) => ({
        content: { ...i.content, question: "[withheld]" },
        withholdings: [{ field: "question", marker: "[withheld]", ref: "r1" }],
      }),
    };
    const r = await new SanitizationPipeline([s]).run({ content: { question: "x" } });
    expect(r.content.question).toBe("[withheld]");
    expect(r.withholdings).toEqual([{ field: "question", marker: "[withheld]", ref: "r1" }]);
  });

  it("applies sanitizers in order, threading content through each", async () => {
    const append = (tag: string): Sanitizer => ({
      name: tag,
      sanitize: (i) => ({
        content: { ...i.content, trail: `${(i.content.trail as string | undefined) ?? ""}${tag}` },
        withholdings: [],
      }),
    });
    const r = await new SanitizationPipeline([append("a"), append("b"), append("c")]).run({
      content: {},
    });
    expect(r.content.trail).toBe("abc");
  });

  it("accumulates withholdings across sanitizers in application order", async () => {
    const wh = (field: string, ref: string): Sanitizer => ({
      name: ref,
      sanitize: (i) => ({ content: i.content, withholdings: [{ field, marker: "[w]", ref }] }),
    });
    const r = await new SanitizationPipeline([wh("a", "r1"), wh("b", "r2")]).run({ content: {} });
    expect(r.withholdings.map((w) => w.ref)).toEqual(["r1", "r2"]);
  });

  it("propagates a sanitizer error (caller fails closed)", async () => {
    const boom: Sanitizer = {
      name: "boom",
      sanitize: () => {
        throw new Error("kaboom");
      },
    };
    await expect(new SanitizationPipeline([boom]).run({ content: {} })).rejects.toThrow("kaboom");
  });

  it("awaits async sanitizers", async () => {
    const asyncS: Sanitizer = {
      name: "async",
      sanitize: async (i) => ({ content: { ...i.content, seen: true }, withholdings: [] }),
    };
    const r = await new SanitizationPipeline([asyncS]).run({ content: {} });
    expect(r.content.seen).toBe(true);
  });

  it("threads deploymentRef through to each sanitizer", async () => {
    const seen: (string | undefined)[] = [];
    const probe = (name: string): Sanitizer => ({
      name,
      sanitize: (i) => {
        seen.push(i.deploymentRef);
        return { content: i.content, withholdings: [] };
      },
    });
    await new SanitizationPipeline([probe("a"), probe("b")]).run({
      content: {},
      deploymentRef: "dep-1",
    });
    expect(seen).toEqual(["dep-1", "dep-1"]);
  });
});
