import { describe, it, expect } from "vitest";
import { DecisionRequestSchema } from "@runforge/decision-protocol";
import { buildReleaseDecisionRequest, releaseDecisionId } from "./build-request.js";
import type { ReleaseProposal } from "./types.js";

const proposal: ReleaseProposal = {
  deployment: "acme/widgets",
  targetRevision: "abc123456789",
  sinceRevision: "prev0000",
  coveredWork: [{ sha: "c1", subject: "add feature", issueNumbers: [12, 14] }],
  declaredPath: { kind: "platform-performs" },
  summary: "Release acme/widgets: 1 change since prev0000 → abc12345",
};

describe("buildReleaseDecisionRequest", () => {
  it("parses through the REAL DecisionRequestSchema", () => {
    expect(() =>
      DecisionRequestSchema.parse(
        buildReleaseDecisionRequest(proposal, { now: "2026-07-03T00:00:00Z" }),
      ),
    ).not.toThrow();
  });

  it("is a release-phase approve/reject P0 external-effect decision", () => {
    const r = buildReleaseDecisionRequest(proposal, { now: "2026-07-03T00:00:00Z" });
    expect(r.phase).toBe("release");
    expect(r.risk_class).toBe("P0");
    expect(r.reversibility).toBe("external_effect");
    expect(r.options.map((o) => o.id).sort()).toEqual(["approve", "reject"]);
    expect(r.answer_schema).toEqual({ kind: "option" });
  });

  it("has a deterministic id == idempotency_key keyed on deployment+target", () => {
    const a = buildReleaseDecisionRequest(proposal, { now: "2026-07-03T00:00:00Z" });
    const b = buildReleaseDecisionRequest(proposal, { now: "2026-07-03T09:00:00Z" });
    expect(a.decision_id).toBe(releaseDecisionId("acme/widgets", "abc123456789"));
    expect(a.decision_id).toBe(a.idempotency_key);
    expect(a.decision_id).toBe(b.decision_id);
  });

  it("carries ONLY structured-safe context — never raw commit bodies", () => {
    const withBody: ReleaseProposal = {
      ...proposal,
      coveredWork: [
        { sha: "c1", subject: "SECRET token=abc; DROP TABLE users;", issueNumbers: [] },
      ],
    };
    const r = buildReleaseDecisionRequest(withBody, { now: "2026-07-03T00:00:00Z" });
    expect(r.context).not.toContain("DROP TABLE");
    expect(r.context).not.toContain("SECRET token");
  });
});
