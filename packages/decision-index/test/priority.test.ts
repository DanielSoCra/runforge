import { describe, it, expect } from "vitest";
import { score, rank, type PriorityItem, type FocusContext } from "../src/priority.js";

const NOW = new Date("2026-05-27T12:00:00.000Z");
const focus = (overrides: Partial<FocusContext> = {}): FocusContext => ({
  now: NOW,
  ...overrides,
});

function item(o: Partial<PriorityItem> & { decision_id: string }): PriorityItem {
  return {
    risk_class: "P2",
    created_at: "2026-05-27T11:30:00.000Z",
    expires_at: null,
    ...o,
  };
}

describe("priority scoring", () => {
  it("orders by risk_class (P0 > P1 > P2 > P3)", () => {
    const items = [
      item({ decision_id: "d-p3", risk_class: "P3" }),
      item({ decision_id: "d-p0", risk_class: "P0" }),
      item({ decision_id: "d-p2", risk_class: "P2" }),
      item({ decision_id: "d-p1", risk_class: "P1" }),
    ];
    const ranked = rank(items, focus()).map((r) => r.item.decision_id);
    expect(ranked).toEqual(["d-p0", "d-p1", "d-p2", "d-p3"]);
  });

  it("focus boost lifts a focused deployment above an equal-risk peer", () => {
    const a = item({ decision_id: "a", deployment: "acme" });
    const b = item({ decision_id: "b", deployment: "other" });
    const ranked = rank([a, b], focus({ focusDeployments: ["acme"] }));
    expect(ranked[0]!.item.decision_id).toBe("a");
  });

  it("pin overrides risk", () => {
    const lowPinned = item({ decision_id: "low", risk_class: "P3", pinned: true });
    const highUnpinned = item({ decision_id: "high", risk_class: "P0" });
    const ranked = rank([highUnpinned, lowPinned], focus());
    expect(ranked[0]!.item.decision_id).toBe("low");
  });

  it("muted and deferred items are suppressed from the ranking", () => {
    const muted = item({ decision_id: "m", muted: true });
    const deferred = item({ decision_id: "d", deferred_until: "2026-05-28T00:00:00.000Z" });
    const normal = item({ decision_id: "n" });
    const ranked = rank([muted, deferred, normal], focus()).map((r) => r.item.decision_id);
    expect(ranked).toEqual(["n"]);
  });

  it("why_ranked is present and explains the contributing terms", () => {
    const r = score(
      item({ decision_id: "x", risk_class: "P1", deployment: "acme" }),
      focus({ focusDeployments: ["acme"] }),
    );
    expect(r.why_ranked).toContain("risk P1");
    expect(r.why_ranked).toContain("focus(acme)");
    expect(r.why_ranked).toContain("age=");
    expect(r.suppressed).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const it = item({ decision_id: "x", risk_class: "P1" });
    expect(score(it, focus())).toEqual(score(it, focus()));
  });

  it("stale items are penalized but not removed", () => {
    const fresh = score(item({ decision_id: "f", risk_class: "P2" }), focus());
    const stale = score(item({ decision_id: "s", risk_class: "P2", stale: true }), focus());
    expect(stale.score).toBeLessThan(fresh.score);
    expect(stale.suppressed).toBe(false);
  });
});
