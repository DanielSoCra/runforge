import { describe, it, expect, vi } from "vitest";
import type { DecisionRequest } from "@auto-claude/decision-protocol";
import type {
  AppendReleaseEvent,
  ReleaseEventRow,
  ReleaseLedgerReader,
  ReleaseLedgerWriter,
} from "@auto-claude/release-ledger";
import { createReleaseLane, type ReleaseLaneDeps } from "./executor.js";

const DEPLOY = "acme/widgets";
const ISSUE = 4242;
const NOW = "2026-07-03T00:00:00.000Z";

function makeFakeLedger(hasPriorApprovedRelease: boolean) {
  const events: ReleaseEventRow[] = [];
  let nextId = 1;
  const seed = (
    e: Partial<ReleaseEventRow> & Pick<ReleaseEventRow, "releaseId" | "deployment" | "event">,
  ): void => {
    events.push({ id: nextId++, at: NOW, targetRevision: null, detail: {}, ...e });
  };

  const reader: ReleaseLedgerReader = {
    eventsForRelease: vi.fn(async (deployment: string, releaseId: string) =>
      events
        .filter((r) => r.deployment === deployment && r.releaseId === releaseId)
        .sort((a, b) => a.id - b.id),
    ),
    lastReleasedMarker: vi.fn(async () => undefined),
    latestOutcome: vi.fn(async () => undefined),
    openReleases: vi.fn(async () => []),
    hasPriorApprovedRelease: vi.fn(async () => hasPriorApprovedRelease),
    hasDebutAuthorization: vi.fn(async () => false),
  };

  const writer: ReleaseLedgerWriter = {
    append: vi.fn(async (e: AppendReleaseEvent) => {
      seed(e);
    }),
    appendProposalIfAbsent: vi.fn(async (e: AppendReleaseEvent & { event: "proposal" }) => {
      if (events.some((r) => r.releaseId === e.releaseId && r.event === "proposal")) return false;
      seed(e);
      return true;
    }),
    appendAttemptIfAbsent: vi.fn(async (e: AppendReleaseEvent & { event: "attempt" }) => {
      if (events.some((r) => r.releaseId === e.releaseId && r.event === "attempt")) return false;
      seed(e);
      return true;
    }),
    reader: () => reader,
    close: vi.fn(async () => {}),
  };

  return { writer, reader, events };
}

function makeDecisionManager() {
  const ledger = {
    raise: vi.fn(async (req: DecisionRequest) => ({ decision_id: req.decision_id })),
    notify: vi.fn(async (_id: string) => {}),
    answer: vi.fn(async (_id: string, _ans: string, _actor: string) => {}),
    advanceToResumed: vi.fn(async (_id: string) => {}),
    statusOf: vi.fn(async (_id: string) => "raised"),
  };
  return {
    markRuntimeDegraded: vi.fn((_reason: string) => {}),
    clearRuntimeDegraded: vi.fn(() => {}),
    ledger: () => ledger,
    _ledger: ledger,
  };
}

function makeHarness(hasPriorApprovedRelease: boolean) {
  const ledger = makeFakeLedger(hasPriorApprovedRelease);
  const decisionManager = makeDecisionManager();
  const publisher = { ensure: vi.fn(async (_a: unknown) => ({ posted: true })) };
  const sanitize = vi.fn(async (req: DecisionRequest) => req);

  // proposeRelease routes through assembleReleaseProposal, which reads the
  // declared landing target off the registry and the trunk head off trunkReader.
  // Drive it to a real `proposal` so ensureDecisionRaised runs and we can assert
  // the offered options (J29 debut logic). Shapes mirror proposal.test.ts.
  const registry = {
    readDeclaredData: () => ({
      kind: "found" as const,
      value: { landsOn: "main", productionReleasePath: { kind: "platform-performs" } },
    }),
  };
  const trunkReader = {
    getTrunkHead: async () => ({ sha: "sha-head" }),
    compareSince: async () => ({ commits: [] }),
    listRecent: async () => ({ commits: [{ sha: "recent-1", subject: "old #99", issueNumbers: [99] }] }),
  };

  const deps = {
    registry: registry as unknown,
    repositoriesFor: (_d: string) => [{ owner: "acme", name: "widgets" }],
    ledger: ledger.writer,
    trunkReader: trunkReader as unknown,
    promotion: {
      promote: vi.fn(),
      rollback: vi.fn(),
      fireTrigger: vi.fn(),
    },
    decisionManager,
    publisher: publisher as unknown,
    sanitize,
    readAnswer: vi.fn(async () => "approve" as const),
    octokit: {} as unknown,
    issueNumberFor: (_d: string) => ISSUE,
  } as unknown as ReleaseLaneDeps;

  return { deps, ledger, decisionManager, publisher, sanitize };
}

describe("release executor — debut option (J29)", () => {
  it("offers three options when there is no prior approved release", async () => {
    const { deps, decisionManager } = makeHarness(false);
    const lane = createReleaseLane(deps);
    const res = await lane.proposeRelease(DEPLOY);
    expect(res.kind).toBe("raised");

    const raised = decisionManager._ledger.raise.mock.calls[0]?.[0] as DecisionRequest | undefined;
    expect(raised).toBeDefined();
    const optionIds = raised!.options.map((o) => o.id).sort();
    expect(optionIds).toEqual(["approve", "approve-with-debut", "reject"]);
    expect(raised!.answer_schema.kind).toBe("option");
  });

  it("offers two options when there is a prior approved release", async () => {
    const { deps, decisionManager } = makeHarness(true);
    const lane = createReleaseLane(deps);
    const res = await lane.proposeRelease(DEPLOY);
    expect(res.kind).toBe("raised");

    const raised = decisionManager._ledger.raise.mock.calls[0]?.[0] as DecisionRequest | undefined;
    expect(raised).toBeDefined();
    const optionIds = raised!.options.map((o) => o.id).sort();
    expect(optionIds).toEqual(["approve", "reject"]);
  });
});
