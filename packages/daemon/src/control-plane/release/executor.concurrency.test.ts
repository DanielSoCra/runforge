// Non-gate verifying tests for the two P5 release-lane P1 safety fixes (codex
// deep-review). These exercise createReleaseLane directly (no dynamic-import
// gate scaffolding) so they read as ordinary unit tests:
//
//   1. Concurrent-attempt: two resolveRelease sweeps for the SAME approved
//      release run concurrently → promote fires EXACTLY once, one attempt row,
//      one execution row. The loser observes the atomic attempt-claim losing and
//      returns `pending` WITHOUT executing. (Without the atomic claim both sweeps
//      append `attempt` via a plain append and both call promote → this test goes
//      red — promote called twice.)
//
//   2. Completion-before-hand-off: recordCompletion on a proposal/decision-only
//      release that never handed off (no triggered-awaiting / recorded-awaiting-
//      human) → `already-terminal` (rejected), no completion appended, and the
//      Last-Released Marker does NOT advance. (Without the guard it would accept
//      `released` and forge a live marker from the proposal target.)

import { describe, it, expect, vi } from "vitest";
import type { DecisionRequest } from "@runforge/decision-protocol";
import type {
  AppendReleaseEvent,
  ReleaseEventRow,
  ReleaseLedgerReader,
  ReleaseLedgerWriter,
  ReleaseOutcome,
} from "@runforge/release-ledger";
import { createReleaseLane, type ReleaseLaneDeps } from "./executor.js";

const DEPLOY = "acme/widgets";
const ISSUE = 4242;
const NOW = "2026-07-03T00:00:00.000Z";

// --------------------------------------------------------------------------
// In-memory Release Ledger over one event array. `appendAttemptIfAbsent` models
// the DB's partial unique index atomically: JS is single-threaded, so the sync
// check-then-push runs to completion before another microtask can interleave —
// exactly one concurrent claimant wins. `append` stays NON-atomic (the pre-fix
// behaviour), so a test that reverts the executor to a plain attempt append
// reproduces the double-execution.
// --------------------------------------------------------------------------

function makeFakeLedger() {
  const events: ReleaseEventRow[] = [];
  let nextId = 1;

  const seed = (
    e: Partial<ReleaseEventRow> &
      Pick<ReleaseEventRow, "releaseId" | "deployment" | "event">,
  ): void => {
    events.push({
      id: nextId++,
      at: NOW,
      targetRevision: null,
      detail: {},
      ...e,
    });
  };

  const reader: ReleaseLedgerReader = {
    eventsForRelease: vi.fn(async (deployment: string, releaseId: string) =>
      events
        .filter((r) => r.deployment === deployment && r.releaseId === releaseId)
        .sort((a, b) => a.id - b.id),
    ),
    lastReleasedMarker: vi.fn(async (deployment: string) => {
      const rows = events
        .filter(
          (r) =>
            r.deployment === deployment &&
            (r.event === "execution" || r.event === "completion"),
        )
        .sort((a, b) => b.id - a.id);
      for (const r of rows) {
        if ((r.detail as { outcome?: string }).outcome === "released") {
          return r.targetRevision ?? undefined;
        }
      }
      return undefined;
    }),
    latestOutcome: vi.fn(async (deployment: string, releaseId: string) => {
      const rows = events
        .filter(
          (r) =>
            r.deployment === deployment &&
            r.releaseId === releaseId &&
            (r.event === "execution" || r.event === "completion"),
        )
        .sort((a, b) => b.id - a.id);
      return rows[0]
        ? ((rows[0].detail as { outcome?: ReleaseOutcome }).outcome as
            | ReleaseOutcome
            | undefined)
        : undefined;
    }),
    openReleases: vi.fn(async () => {
      const byRel = new Map<string, ReleaseEventRow[]>();
      for (const r of events) {
        const arr = byRel.get(r.releaseId) ?? [];
        arr.push(r);
        byRel.set(r.releaseId, arr);
      }
      const out: {
        deployment: string;
        releaseId: string;
        detail: Record<string, unknown>;
      }[] = [];
      for (const [releaseId, rows] of byRel) {
        const proposal = rows.find((r) => r.event === "proposal");
        const resolved = rows.some((r) => r.event === "resolved");
        if (proposal && !resolved) {
          out.push({ deployment: proposal.deployment, releaseId, detail: proposal.detail });
        }
      }
      return out;
    }),
    hasPriorApprovedRelease: vi.fn(async () => false),
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
    // Atomic single-attempt claim: sync check-then-push (no await between) so two
    // concurrent callers cannot both win — models the partial unique index.
    appendAttemptIfAbsent: vi.fn(async (e: AppendReleaseEvent & { event: "attempt" }) => {
      if (events.some((r) => r.releaseId === e.releaseId && r.event === "attempt")) return false;
      seed(e);
      return true;
    }),
    reader: () => reader,
    close: vi.fn(async () => {}),
  };

  return {
    writer,
    reader,
    events,
    seed,
    countEvents: (kind: ReleaseEventRow["event"], releaseId?: string) =>
      events.filter(
        (r) => r.event === kind && (releaseId === undefined || r.releaseId === releaseId),
      ).length,
  };
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

function makePromotion() {
  return {
    promote: vi.fn(async (_a: { deployment: string; targetRevision: string }) => {}),
    rollback: vi.fn(async (_a: { deployment: string; toRevision: string | undefined }) => {}),
    fireTrigger: vi.fn(
      async (_a: { deployment: string; trigger: string; targetRevision: string }) => {},
    ),
  };
}

function makeHarness() {
  const ledger = makeFakeLedger();
  const promotion = makePromotion();
  const decisionManager = makeDecisionManager();
  const publisher = { ensure: vi.fn(async (_a: unknown) => ({ posted: true })) };
  const sanitize = vi.fn(async (req: DecisionRequest) => req);
  const readAnswer = vi.fn(
    async (_d: string, _id: string, _issue: number) => "approve" as const,
  );

  const deps = {
    registry: {} as unknown,
    repositoriesFor: (_d: string) => [{ owner: "acme", name: "widgets" }],
    ledger: ledger.writer,
    trunkReader: {} as unknown,
    promotion,
    decisionManager,
    publisher: publisher as unknown,
    sanitize,
    readAnswer,
    octokit: {} as unknown,
    issueNumberFor: (_d: string) => ISSUE,
  } as unknown as ReleaseLaneDeps;

  return { deps, ledger, promotion, decisionManager, publisher, sanitize, readAnswer };
}

const seedProposal = (
  ledger: ReturnType<typeof makeFakeLedger>,
  releaseId: string,
  targetRevision: string,
  declaredPath: unknown,
): void => {
  ledger.seed({
    releaseId,
    deployment: DEPLOY,
    event: "proposal",
    targetRevision,
    detail: {
      deployment: DEPLOY,
      targetRevision,
      sinceRevision: "prev0000",
      coveredWork: [{ sha: "c1", subject: "add feature", issueNumbers: [12] }],
      declaredPath,
      summary: "Release acme/widgets",
      issueNumber: ISSUE,
    },
  });
};

describe("release executor — concurrent attempt claim (codex P1)", () => {
  it("two concurrent resolveRelease sweeps promote EXACTLY once (loser returns pending)", async () => {
    const { deps, ledger, promotion } = makeHarness();
    const lane = createReleaseLane(deps);
    const releaseId = "release:acme/widgets:sha-appr";
    seedProposal(ledger, releaseId, "sha-approved", { kind: "platform-performs" });
    // A decision(approve) already exists — both sweeps read the same stale rows
    // snapshot with an attempt-less, decision-present release and race to execute.
    ledger.seed({ releaseId, deployment: DEPLOY, event: "decision", detail: { answer: "approve" } });

    const [a, b] = await Promise.all([
      lane.resolveRelease(DEPLOY, releaseId),
      lane.resolveRelease(DEPLOY, releaseId),
    ]);

    // Exactly one real side effect.
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(ledger.countEvents("attempt", releaseId)).toBe(1);
    expect(ledger.countEvents("execution", releaseId)).toBe(1);

    // One sweep executed, the other lost the claim and is pending (no execution).
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["executed", "pending"]);
    const executed = [a, b].find((r) => r.kind === "executed");
    expect(executed).toEqual(expect.objectContaining({ kind: "executed", outcome: "released" }));
  });

  it("trigger-automated: two concurrent sweeps fire the trigger EXACTLY once", async () => {
    const { deps, ledger, promotion } = makeHarness();
    const lane = createReleaseLane(deps);
    const releaseId = "release:acme/widgets:sha-trg";
    seedProposal(ledger, releaseId, "sha-trigger", {
      kind: "trigger-automated",
      trigger: "deploy-workflow",
    });
    ledger.seed({ releaseId, deployment: DEPLOY, event: "decision", detail: { answer: "approve" } });

    const [a, b] = await Promise.all([
      lane.resolveRelease(DEPLOY, releaseId),
      lane.resolveRelease(DEPLOY, releaseId),
    ]);

    expect(promotion.fireTrigger).toHaveBeenCalledTimes(1);
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(ledger.countEvents("attempt", releaseId)).toBe(1);
    expect(ledger.countEvents("execution", releaseId)).toBe(1);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["executed", "pending"]);
  });
});

describe("release executor — recordCompletion requires a hand-off (codex P1)", () => {
  it("rejects a completion before any hand-off (no execution) and does NOT advance the marker", async () => {
    const { deps, ledger } = makeHarness();
    const lane = createReleaseLane(deps);
    const releaseId = "release:acme/widgets:sha-nohandoff";
    // Proposal + decision only — the approval/execution path never ran, so no
    // triggered-awaiting / recorded-awaiting-human hand-off exists.
    seedProposal(ledger, releaseId, "sha-target", { kind: "trigger-automated", trigger: "wf" });
    ledger.seed({ releaseId, deployment: DEPLOY, event: "decision", detail: { answer: "approve" } });

    const before = ledger.events.length;
    const result = await lane.recordCompletion(DEPLOY, releaseId, "released");

    expect(result).toBe("already-terminal");
    expect(ledger.events.length).toBe(before); // no completion appended
    expect(ledger.countEvents("completion", releaseId)).toBe(0);
    // The forged live marker never materialises.
    expect(await ledger.reader.lastReleasedMarker(DEPLOY)).toBeUndefined();
  });

  it("accepts a completion for a genuinely handed-off (triggered-awaiting) release and advances the marker", async () => {
    const { deps, ledger } = makeHarness();
    const lane = createReleaseLane(deps);
    const releaseId = "release:acme/widgets:sha-handed";
    seedProposal(ledger, releaseId, "sha-live", { kind: "trigger-automated", trigger: "wf" });
    ledger.seed({
      releaseId,
      deployment: DEPLOY,
      event: "execution",
      targetRevision: "sha-live",
      detail: { outcome: "triggered-awaiting" },
    });

    // Non-final hand-off does not advance the marker on its own.
    expect(await ledger.reader.lastReleasedMarker(DEPLOY)).toBeUndefined();

    const result = await lane.recordCompletion(DEPLOY, releaseId, "released");
    expect(result).toBe("applied");
    expect(ledger.countEvents("completion", releaseId)).toBe(1);
    // Only the completion(released) advances the Last-Released Marker.
    expect(await ledger.reader.lastReleasedMarker(DEPLOY)).toBe("sha-live");
  });
});
