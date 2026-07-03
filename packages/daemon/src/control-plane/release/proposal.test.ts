import { describe, it, expect, vi } from "vitest";
import { assembleReleaseProposal, type TrunkReader } from "./proposal.js";

const landingFound = (path: unknown) => ({
  readDeclaredData: () =>    ({ kind: "found" as const, value: { landsOn: "main", productionReleasePath: path } }),
});
const repos = [{ owner: "acme", name: "widgets" }];
const SINCE = [{ sha: "since-1", subject: "fix #12", issueNumbers: [12] }];
const RECENT = [
  { sha: "recent-1", subject: "old #99", issueNumbers: [99] },
  { sha: "recent-2", subject: "older #98", issueNumbers: [98] },
];
const makeTrunk = (headSha: string) => {
  const compareSince = vi.fn(async () => ({ commits: SINCE }));
  const listRecent = vi.fn(async () => ({ commits: RECENT }));
  const trunkReader: TrunkReader = {
    getTrunkHead: async () => ({ sha: headSha }),
    compareSince,
    listRecent,
  };
  return { trunkReader, compareSince, listRecent };
};

describe("assembleReleaseProposal — per-deployment since-last-release", () => {
  it("diffs since the marker (compareSince, base=marker) — NOT recent commits", async () => {
    const { trunkReader, compareSince, listRecent } = makeTrunk("sha-head");
    const res = await assembleReleaseProposal({
      deployment: "acme/widgets",
      registry: landingFound({ kind: "platform-performs" }),
      repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => "sha-prev" },
      trunkReader,
    });
    expect(res.kind).toBe("proposal");
    if (res.kind !== "proposal") return;
    expect(compareSince).toHaveBeenCalledWith("acme", "widgets", "sha-prev", "sha-head");
    expect(listRecent).not.toHaveBeenCalled();
    expect(res.proposal.sinceRevision).toBe("sha-prev");
    expect(res.proposal.targetRevision).toBe("sha-head");
    expect(res.proposal.declaredPath).toEqual({ kind: "platform-performs" });
    expect(res.proposal.coveredWork).toEqual(SINCE);
  });

  it("reports nothing-to-release when trunk head equals the marker", async () => {
    const { trunkReader } = makeTrunk("sha-head");
    const res = await assembleReleaseProposal({
      deployment: "acme/widgets",
      registry: landingFound({ kind: "platform-performs" }),
      repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => "sha-head" },
      trunkReader,
    });
    expect(res.kind).toBe("nothing-to-release");
  });

  it("uses listRecent for a first release (no prior marker) and covers that set", async () => {
    const { trunkReader, compareSince, listRecent } = makeTrunk("sha-head");
    const res = await assembleReleaseProposal({
      deployment: "acme/widgets",
      registry: landingFound({ kind: "record-only", procedure: "runbook" }),
      repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined },
      trunkReader,
    });
    expect(res.kind).toBe("proposal");
    if (res.kind !== "proposal") return;
    expect(compareSince).not.toHaveBeenCalled();
    expect(listRecent).toHaveBeenCalledWith("acme", "widgets", "sha-head");
    expect(res.proposal.sinceRevision).toBeUndefined();
    expect(res.proposal.coveredWork).toEqual(RECENT);
  });

  it("is unresolvable (fail closed) when landing is not declared", async () => {
    const { trunkReader } = makeTrunk("h");
    const res = await assembleReleaseProposal({
      deployment: "x",
      registry: { readDeclaredData: () => ({ kind: "not-found" as const }) },
      repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined },
      trunkReader,
    });
    expect(res.kind).toBe("unresolvable");
  });

  it("is unresolvable when productionReleasePath is malformed", async () => {
    const { trunkReader } = makeTrunk("h");
    const res = await assembleReleaseProposal({
      deployment: "acme/widgets",
      registry: landingFound("tag-and-deploy"),
      repositories: repos,
      ledgerReader: { lastReleasedMarker: async () => undefined },
      trunkReader,
    });
    expect(res.kind).toBe("unresolvable");
  });
});
