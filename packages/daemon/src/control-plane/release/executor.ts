import type { DecisionRequest } from "@auto-claude/decision-protocol";
import type { Octokit } from "@octokit/rest";
import { DeclaredReleasePathSchema } from "../deployment-registry/schema.js";
import type { DeploymentRegistry } from "../deployment-registry/registry.js";
import type { GitHubBlockPublisher } from "../decision-escalation/github-block-notifier.js";
import {
  markRuntimeDegradedIfGoverned,
  clearRuntimeDegradedIfGoverned,
  withGovernedDecisionMarking,
  type RuntimeDegradable,
} from "../decision-escalation/manager.js";
import type {
  AppendReleaseEvent,
  ReleaseLedgerWriter,
  ReleaseLedgerReader,
  ReleaseOutcome,
} from "@auto-claude/release-ledger";
import { assembleReleaseProposal } from "./proposal.js";
import { buildReleaseDecisionRequest, releaseDecisionId } from "./build-request.js";
import type {
  PreviewResult,
  ReleaseProposal,
  TrunkReader,
} from "./types.js";

export interface PromotionPort {
  promote(a: { deployment: string; targetRevision: string }): Promise<void>;
  rollback(a: { deployment: string; toRevision: string | undefined }): Promise<void>;
  fireTrigger(a: {
    deployment: string;
    trigger: string;
    targetRevision: string;
  }): Promise<void>;
}

export interface DecisionManagerLike extends RuntimeDegradable {
  ledger: () => {
    raise: (req: DecisionRequest) => Promise<{ decision_id: string }>;
    notify: (decisionId: string) => Promise<unknown>;
    answer: (decisionId: string, chosenOption: string, answerer: string) => Promise<unknown>;
    advanceToResumed: (decisionId: string) => Promise<void>;
    statusOf: (decisionId: string) => Promise<string | undefined>;
  };
}

export interface ReleaseLaneDeps {
  registry: DeploymentRegistry;
  repositoriesFor: (deployment: string) => { owner: string; name: string }[];
  ledger: ReleaseLedgerWriter;
  trunkReader: TrunkReader;
  promotion: PromotionPort;
  decisionManager: DecisionManagerLike;
  publisher: GitHubBlockPublisher;
  sanitize: (req: DecisionRequest) => Promise<DecisionRequest>;
  readAnswer: (
    deployment: string,
    decisionId: string,
    issueNumber: number,
  ) => Promise<"approve" | "reject" | undefined>;
  octokit: Octokit;
  issueNumberFor: (deployment: string) => number;
}

export type ProposeResult =
  | { kind: "raised"; decisionId: string }
  | { kind: "nothing-to-release" }
  | { kind: "unresolvable"; reason: string }
  | { kind: "degraded"; reason: string };

export type ResolveResult =
  | { kind: "executed"; outcome: ReleaseOutcome }
  | { kind: "rejected" }
  | { kind: "pending" }
  | { kind: "already-resolved" }
  | { kind: "unresolvable"; reason: string }
  | { kind: "degraded"; reason: string };

export interface ReleaseLane {
  previewRelease(deployment: string): Promise<PreviewResult>;
  proposeRelease(deployment: string): Promise<ProposeResult>;
  resolveRelease(deployment: string, decisionId: string): Promise<ResolveResult>;
  recordCompletion(
    deployment: string,
    releaseId: string,
    outcome: "released" | "failed",
  ): Promise<"applied" | "already-terminal">;
}

function isReleaseOutcome(
  value: unknown,
): value is "released" | "triggered-awaiting" | "recorded-awaiting-human" | "failed" {
  return (
    value === "released" ||
    value === "triggered-awaiting" ||
    value === "recorded-awaiting-human" ||
    value === "failed"
  );
}

function asReleaseOutcome(value: unknown): ReleaseOutcome | undefined {
  return isReleaseOutcome(value) ? value : undefined;
}

export function createReleaseLane(deps: ReleaseLaneDeps): ReleaseLane {
  const {
    registry,
    repositoriesFor,
    ledger,
    trunkReader,
    promotion,
    decisionManager,
    publisher,
    sanitize,
    readAnswer,
    octokit,
    issueNumberFor,
  } = deps;

  async function previewRelease(deployment: string): Promise<PreviewResult> {
    return assembleReleaseProposal({
      deployment,
      registry,
      repositories: repositoriesFor(deployment),
      ledgerReader: ledger.reader(),
      trunkReader,
    });
  }

  async function ensureDecisionRaised(
    proposal: ReleaseProposal,
    issueNumber: number,
  ): Promise<boolean> {
    const req = buildReleaseDecisionRequest(proposal);
    const sanitized = await sanitize(req);
    const deployment = proposal.deployment;
    const repo = repositoriesFor(deployment)[0];
    if (!repo) {
      markRuntimeDegradedIfGoverned(
        decisionManager,
        deployment,
        "release lane missing repository",
      );
      return false;
    }
    const { decision_id } = await withGovernedDecisionMarking(
      decisionManager,
      deployment,
      () => decisionManager.ledger().raise(sanitized),
    );
    const published = await publisher.ensure({
      request: sanitized,
      octokit,
      owner: repo.owner,
      repo: repo.name,
      issueNumber,
    });
    if (published.posted) {
      await withGovernedDecisionMarking(decisionManager, deployment, () =>
        decisionManager.ledger().notify(decision_id),
      );
      clearRuntimeDegradedIfGoverned(decisionManager, deployment);
    }
    return published.posted;
  }

  async function appendResolved(
    deployment: string,
    releaseId: string,
    answer: string,
  ): Promise<void> {
    await ledger.append({
      releaseId,
      deployment,
      event: "resolved",
      targetRevision: null,
      detail: { answer },
    });
  }

  async function terminalize(
    deployment: string,
    releaseId: string,
    answer: string,
  ): Promise<void> {
    await decisionManager.ledger().answer(releaseId, answer, "operator");
    await decisionManager.ledger().advanceToResumed(releaseId);
  }

  // Atomically CLAIM the single execution attempt for this release, mirroring the
  // proposal claim (partial unique index + appendAttemptIfAbsent). Two concurrent
  // release sweeps (multi-repo pollers) can both reach the approve branch with the
  // same stale `rows` snapshot (neither saw an attempt yet); the DB unique index
  // lets exactly ONE insert the attempt row. Only that caller (returns true) runs
  // the promote/fireTrigger side effects; the loser (returns false) must not, and
  // returns `pending` so a later sweep re-picks via openReleases if the winner
  // never terminalizes. The in-memory gate-test writer double is single-threaded
  // and does not model the atomic claim, so fall back to a plain append there.
  async function claimAttempt(
    e: AppendReleaseEvent & { event: "attempt" },
  ): Promise<boolean> {
    if (ledger.appendAttemptIfAbsent) {
      return ledger.appendAttemptIfAbsent(e);
    }
    await ledger.append(e);
    return true;
  }

  async function proposeRelease(deployment: string): Promise<ProposeResult> {
    const preview = await assembleReleaseProposal({
      deployment,
      registry,
      repositories: repositoriesFor(deployment),
      ledgerReader: ledger.reader(),
      trunkReader,
    });
    if (preview.kind !== "proposal") {
      return preview;
    }

    const proposal = preview.proposal;
    const releaseId = releaseDecisionId(deployment, proposal.targetRevision);
    const issueNumber = issueNumberFor(deployment);

    try {
      await ledger.appendProposalIfAbsent({
        releaseId,
        deployment,
        event: "proposal",
        targetRevision: proposal.targetRevision,
        detail: { ...proposal, issueNumber },
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      markRuntimeDegradedIfGoverned(
        decisionManager,
        deployment,
        `release-ledger unavailable: ${reason}`,
      );
      return { kind: "degraded", reason };
    }

    try {
      const posted = await ensureDecisionRaised(proposal, issueNumber);
      if (!posted) {
        markRuntimeDegradedIfGoverned(
          decisionManager,
          deployment,
          "release decision not posted",
        );
        return { kind: "degraded", reason: "not-posted" };
      }
      return { kind: "raised", decisionId: releaseId };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { kind: "degraded", reason };
    }
  }

  async function resolveRelease(
    deployment: string,
    decisionId: string,
  ): Promise<ResolveResult> {
    // Any ledger read/write failure across the whole resolve path fails closed:
    // mark the deployment degraded and return `degraded` rather than letting the
    // throw escape (mirrors proposeRelease). The inner fn holds the logic; this
    // wrapper is the single fail-closed boundary for the ledger writes too (the
    // decision/execution appends), not just the initial read.
    try {
      return await resolveReleaseInner(deployment, decisionId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      markRuntimeDegradedIfGoverned(
        decisionManager,
        deployment,
        `release-ledger unavailable: ${reason}`,
      );
      return { kind: "degraded", reason };
    }
  }

  async function resolveReleaseInner(
    deployment: string,
    decisionId: string,
  ): Promise<ResolveResult> {
    const releaseId = decisionId;
    const rows: Awaited<ReturnType<ReleaseLedgerReader["eventsForRelease"]>> =
      await ledger.reader().eventsForRelease(deployment, releaseId);

    const proposalRow = rows.find((r) => r.event === "proposal");
    if (!proposalRow) {
      return {
        kind: "unresolvable",
        reason: "no proposal event for release",
      };
    }

    const detail = proposalRow.detail;
    const targetRevision =
      typeof detail.targetRevision === "string"
        ? detail.targetRevision
        : (proposalRow.targetRevision ?? "");
    const declaredPathRaw = detail.declaredPath;
    const issueNumber =
      typeof detail.issueNumber === "number" ? detail.issueNumber : 0;
    const declaredPathParse = DeclaredReleasePathSchema.safeParse(declaredPathRaw);
    if (!declaredPathParse.success) {
      return {
        kind: "unresolvable",
        reason: "stored declared path is missing or invalid",
      };
    }
    const declaredPath = declaredPathParse.data;

    const hasResolved = rows.some((r) => r.event === "resolved");
    if (hasResolved) {
      return { kind: "already-resolved" };
    }

    const terminalExecution = rows.find(
      (r) =>
        (r.event === "execution" || r.event === "completion") &&
        asReleaseOutcome(r.detail.outcome) !== undefined,
    );
    if (terminalExecution) {
      const decisionRow = rows.find((r) => r.event === "decision");
      const answer =
        typeof decisionRow?.detail.answer === "string"
          ? decisionRow.detail.answer
          : await readAnswer(deployment, decisionId, issueNumber);
      if (answer === undefined) {
        return { kind: "pending" };
      }
      await terminalize(deployment, releaseId, answer);
      await appendResolved(deployment, releaseId, answer);
      return { kind: "already-resolved" };
    }

    const hasAttempt = rows.some((r) => r.event === "attempt");
    if (hasAttempt) {
      const decisionRow = rows.find((r) => r.event === "decision");
      const answer =
        typeof decisionRow?.detail.answer === "string"
          ? decisionRow.detail.answer
          : await readAnswer(deployment, decisionId, issueNumber);
      if (answer === undefined) {
        return { kind: "pending" };
      }
      await ledger.append({
        releaseId,
        deployment,
        event: "execution",
        targetRevision,
        detail: {
          outcome: "failed",
          reason: "interrupted-outcome-unknown",
        },
      });
      markRuntimeDegradedIfGoverned(
        decisionManager,
        deployment,
        "release execution interrupted — outcome unknown, operator must verify",
      );
      await terminalize(deployment, releaseId, answer);
      await appendResolved(deployment, releaseId, answer);
      return { kind: "executed", outcome: "failed" };
    }

    try {
      const posted = await ensureDecisionRaised(
        {
          deployment,
          targetRevision,
          sinceRevision:
            typeof detail.sinceRevision === "string"
              ? detail.sinceRevision
              : undefined,
          coveredWork:
            Array.isArray(detail.coveredWork) ? (detail.coveredWork as ReleaseProposal["coveredWork"]) : [],
          declaredPath,
          summary: typeof detail.summary === "string" ? detail.summary : "",
        },
        issueNumber,
      );
      if (!posted) {
        return { kind: "degraded", reason: "not-posted" };
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { kind: "degraded", reason };
    }

    const decisionRow = rows.find((r) => r.event === "decision");
    let answer:
      | "approve"
      | "reject"
      | undefined = decisionRow?.detail.answer as
      | "approve"
      | "reject"
      | undefined;
    if (answer === undefined) {
      answer = await readAnswer(deployment, decisionId, issueNumber);
    }
    if (answer === undefined) {
      return { kind: "pending" };
    }

    if (!rows.some((r) => r.event === "decision")) {
      await ledger.append({
        releaseId,
        deployment,
        event: "decision",
        targetRevision: null,
        detail: { answer },
      });
    }

    if (answer === "reject") {
      await terminalize(deployment, releaseId, answer);
      await appendResolved(deployment, releaseId, answer);
      return { kind: "rejected" };
    }

    // approve
    const priorMarker = await ledger.reader().lastReleasedMarker(deployment);
    let outcome: ReleaseOutcome;

    if (declaredPath.kind === "platform-performs") {
      const claimed = await claimAttempt({
        releaseId,
        deployment,
        event: "attempt",
        targetRevision,
        detail: { shape: "platform-performs" },
      });
      if (!claimed) {
        // A concurrent sweep already claimed the attempt and is executing — do NOT
        // re-run promote. The owning sweep drives it to a terminal outcome.
        return { kind: "pending" };
      }
      try {
        await promotion.promote({ deployment, targetRevision });
        await ledger.append({
          releaseId,
          deployment,
          event: "execution",
          targetRevision,
          detail: { outcome: "released" },
        });
        outcome = "released";
      } catch {
        let rollbackFailed = false;
        try {
          await promotion.rollback({ deployment, toRevision: priorMarker });
        } catch {
          rollbackFailed = true;
        }
        await ledger.append({
          releaseId,
          deployment,
          event: "execution",
          targetRevision,
          detail: { outcome: "failed", rollbackFailed },
        });
        markRuntimeDegradedIfGoverned(
          decisionManager,
          deployment,
          rollbackFailed
            ? "platform-performs failed AND rollback failed"
            : "platform-performs failed",
        );
        outcome = "failed";
      }
    } else if (declaredPath.kind === "trigger-automated") {
      const claimed = await claimAttempt({
        releaseId,
        deployment,
        event: "attempt",
        targetRevision,
        detail: { shape: "trigger-automated" },
      });
      if (!claimed) {
        // A concurrent sweep already claimed the attempt and is firing the trigger
        // — do NOT re-fire. The owning sweep drives it to a terminal outcome.
        return { kind: "pending" };
      }
      try {
        await promotion.fireTrigger({
          deployment,
          trigger: declaredPath.trigger,
          targetRevision,
        });
        await ledger.append({
          releaseId,
          deployment,
          event: "execution",
          targetRevision,
          detail: { outcome: "triggered-awaiting" },
        });
        outcome = "triggered-awaiting";
      } catch {
        await ledger.append({
          releaseId,
          deployment,
          event: "execution",
          targetRevision,
          detail: { outcome: "failed" },
        });
        outcome = "failed";
      }
    } else {
      // record-only
      await ledger.append({
        releaseId,
        deployment,
        event: "execution",
        targetRevision,
        detail: { outcome: "recorded-awaiting-human" },
      });
      outcome = "recorded-awaiting-human";
    }

    await terminalize(deployment, releaseId, answer);
    await appendResolved(deployment, releaseId, answer);
    return { kind: "executed", outcome };
  }

  async function recordCompletion(
    deployment: string,
    releaseId: string,
    outcome: "released" | "failed",
  ): Promise<"applied" | "already-terminal"> {
    const latest = await ledger.reader().latestOutcome(deployment, releaseId);
    // Only a genuinely handed-off release may be completed: its latest recorded
    // outcome must be one of the two NON-FINAL hand-off states. Reject otherwise —
    // whether there is no hand-off yet (`undefined`: the approval/execution path
    // never ran, so a completion here would forge a live Last-Released Marker from
    // the proposal target) or the release is already terminal (`released`/`failed`).
    if (latest !== "triggered-awaiting" && latest !== "recorded-awaiting-human") {
      return "already-terminal";
    }
    const rows = await ledger.reader().eventsForRelease(deployment, releaseId);
    const proposalRow = rows.find((r) => r.event === "proposal");
    const targetRevision =
      proposalRow?.targetRevision ??
      (typeof proposalRow?.detail.targetRevision === "string"
        ? proposalRow.detail.targetRevision
        : null);
    await ledger.append({
      releaseId,
      deployment,
      event: "completion",
      targetRevision,
      detail: { outcome },
    });
    return "applied";
  }

  return {
    previewRelease,
    proposeRelease,
    resolveRelease,
    recordCompletion,
  };
}
