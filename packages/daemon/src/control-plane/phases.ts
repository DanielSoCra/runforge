// src/control-plane/phases.ts
import type { PhaseHandlerMap } from './pipeline.js';
import type { PhaseLabelMirror } from './phase-labels.js';
import type { RunState, PhaseEvent, WorkRequest, PhaseArtifact } from '../types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { RunWriter } from '../data/run-writer.js';
import type { Config } from '../config.js';
import { createGate1, selectGates } from '../validation/gates.js';
import { createReviewerGate } from '../validation/reviewer-session.js';
import { isRiskSensitive } from '../validation/risk-detection.js';
import { runReview } from '../validation/review.js';
import { injectKnowledge } from '../validation/knowledge-injector.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import type { Octokit } from '@octokit/rest';
import { createWorkDetector } from './work-detection.js';
import { git } from '../lib/git.js';
import { runCommand } from '../lib/process.js';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { diagnose } from '../diagnosis/diagnostician.js';
import { routeDiagnosis } from '../diagnosis/router.js';
import {
  loadSpecContent,
  loadImplementationContent,
  resolveCurrentSpecRefs,
} from '../infra/spec-loader.js';
import { classify as runClassify } from './classifier.js';
import { SessionError } from '../session-runtime/session-error.js';
import { runHoldout } from '../validation/holdout.js';
import { integrateToStaging } from './integration.js';
import { appendAutoMergeEvent } from './escalation-metrics.js';
import { resolveLandingTarget } from './landing-target.js';
import { awaitRequiredChecks } from './await-checks.js';
import { deliverCodeChangeViaPR } from './pr-delivery.js';
import {
  buildDegradedReversalEscalationRequest,
  handlePostLandingObservation,
  type TrunkObservation,
} from './revert-lane.js';
import { buildProposalKey } from './spec-pipeline/delivery.js';
import { runDeploy } from '../validation/deploy.js';
import { runPostDeployTests } from '../validation/post-deploy-test.js';
import { reconcileWorkspace, ensureRepoFresh } from './workspace.js';
import { extractStructuredOutput } from '../lib/structured-output.js';
import { complianceReportJsonSchema } from '../diagnosis/schema.js';
import { createFailureRecord } from './failure-routing.js';
import {
  deliverPhaseArtifact,
  DeliveryError,
  mergePhaseArtifact,
  reconcilePhaseArtifact,
  type ArtifactReconcileStatus,
  type DeliverableSpecPhase,
} from './spec-pipeline/delivery.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import {
  withGovernedDecisionMarking,
  markRuntimeDegradedIfGoverned,
  clearRuntimeDegradedIfGoverned,
} from './decision-escalation/manager.js';
import { buildL2GateRequest } from './decision-escalation/build-request.js';
import { GitHubBlockPublisher } from './decision-escalation/github-block-notifier.js';
import type { DeploymentRegistry } from './deployment-registry/registry.js';
import type { ComplianceReviewer } from './deployment-registry/types.js';
import { buildMergeDecisionRequest,
  computeTouchedPaths,
  decideMerge,
  evaluateComplianceForced,
  observeVerifierStatus,
} from './merge-decision/index.js';
import { alertOnNotifyApplied, type DecisionRaisedAlert } from './decision-alert.js';
import type { DecisionRequest } from '@auto-claude/decision-protocol';
import { SanitizationPipeline } from '@auto-claude/sanitization';
import { applyDecisionSanitization } from './decision-escalation/sanitize-request.js';
import {
  assignLane,
  evaluateVerifierGate,
  gateSetVerdict,
  resolveForMode,
} from './lane-engine/index.js';
import type {
  ClassifierVerdict,
  GateSetDefinitions,
  RiskLevel,
} from './lane-engine/types.js';
import type { VerifierInvocationRef } from './lane-engine/verifier-gate/types.js';
import type { LaneEngineInputsResult } from './deployment-registry/types.js';
import type { ClassificationComplexity } from '../types.js';

// Serializes git operations on the shared repoRoot across concurrent pipeline runs.
// Currently protects detect (which modifies checkout state via git checkout).
// Review uses explicit branch refs (#178) so it no longer depends on checkout state.
// Single-process cooperative async — boolean suffices (same as integrationLock).
let repoGitLock = false;

type PhaseArtifactReconcileOutcome =
  | { kind: 'event'; event: PhaseEvent }
  | { kind: 'status'; status: ArtifactReconcileStatus };

export function acquireRepoGitLock(): boolean {
  if (repoGitLock) return false;
  repoGitLock = true;
  return true;
}

export function releaseRepoGitLock(): void {
  repoGitLock = false;
}

export function isRepoGitLocked(): boolean {
  return repoGitLock;
}

// Backwards-compat aliases — existing callers use detectLock naming
export const acquireDetectLock = acquireRepoGitLock;
export const releaseDetectLock = releaseRepoGitLock;
export const isDetectLocked = isRepoGitLocked;

/** Build a synchronous, dependency-free probe for whether a verifier's invocation
 * ref is reachable/runnable in the repo workspace. SECURITY BOUNDARY of the
 * verifier-gating chokepoint, so it confirms runnability ONLY for a narrow,
 * positively-recognized set and fails closed on everything else:
 *   - a declared package.json script name, OR
 *   - a real CI workflow file (`.yml`/`.yaml`) strictly under `.github/workflows/`.
 * It deliberately does NOT accept an arbitrary existing file/dir (a README is not a
 * runnable oracle), and rejects absolute refs and any parent-traversal (`..`) so a
 * ref can never reach outside the repo workspace. */
export function createProbeOracle(repoRoot: string): (ref: { ref: string }) => boolean {
  let scriptNames: Set<string> | undefined;
  const workflowDir = normalize(join(repoRoot, '.github', 'workflows')) + sep;

  return (invoke) => {
    const rawRef = invoke.ref.trim();
    if (rawRef === '') return false;
    // Containment: never accept an absolute ref or any parent-traversal segment —
    // the oracle must live inside this repo workspace.
    if (isAbsolute(rawRef) || rawRef.split(/[\\/]/).includes('..')) return false;

    // (1) a declared package.json script name (cached once per integrate attempt).
    if (scriptNames === undefined) {
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
        scriptNames = new Set(Object.keys(pkg.scripts ?? {}));
      } catch {
        scriptNames = new Set();
      }
    }
    if (scriptNames.has(rawRef)) return true;

    // (2) a real CI workflow FILE (.yml/.yaml) strictly under .github/workflows/.
    const candidates = rawRef.startsWith('.github/workflows/')
      ? [rawRef]
      : [`.github/workflows/${rawRef}`, `.github/workflows/${rawRef}.yml`, `.github/workflows/${rawRef}.yaml`];
    for (const rel of candidates) {
      if (!/\.ya?ml$/.test(rel)) continue;
      const abs = normalize(join(repoRoot, rel));
      if (!abs.startsWith(workflowDir)) continue; // belt-and-suspenders containment
      if (existsSync(abs)) return true;
    }

    return false;
  };
}

/** Narrow registry surface the pre-implement verifier gate needs. */
export interface PreImplementVerifierGateRegistry {
  resolveLaneEngineInputs(deploymentId: string): LaneEngineInputsResult;
}

type AssistReason = Extract<
  import('./lane-engine/verifier-gate/types.js').VerifierGateResult,
  { kind: 'assist-and-escalate' }
>['reason'];

export type PreImplementVerifierGateDecision =
  | { kind: 'proceeded'; governed: boolean; laneName?: string }
  | { kind: 'refused'; governed: true; laneName: string; reason: AssistReason };

export interface PreImplementVerifierGateEscalation {
  deploymentId: string;
  laneName: string;
  reason: AssistReason;
}

/**
 * Pre-implement verifier gate (FUNC-AC-VERIFIER-GATE step 4).
 *
 * For a governed deployment, resolve the lane the classifier would assign and
 * verify the lane declares a runnable, falsifying oracle BEFORE any autonomous
 * implementation is dispatched. Fail closed: no verifier / unusable verifier /
 * non-falsifying verifier ⇒ refuse and escalate; do NOT call `implement`.
 *
 * For an ungoverned run (no deploymentId or no registry), the gate is inert and
 * `implement` is called to preserve legacy behavior.
 */
export async function checkVerifierGateBeforeImplement(args: {
  deploymentId?: string;
  registry?: PreImplementVerifierGateRegistry;
  classifierVerdict: ClassifierVerdict | null;
  probeOracle: (invoke: VerifierInvocationRef) => boolean;
  implement: () => Promise<unknown>;
  escalate: (event: PreImplementVerifierGateEscalation) => Promise<void>;
}): Promise<PreImplementVerifierGateDecision> {
  const { deploymentId, registry, classifierVerdict, probeOracle, implement, escalate } = args;

  // Ungoverned: preserve legacy behavior; do not probe.
  if (deploymentId === undefined || registry === undefined) {
    await implement();
    return { kind: 'proceeded', governed: false };
  }

  const resolved = registry.resolveLaneEngineInputs(deploymentId);
  if (resolved.kind !== 'found') {
    const laneName = resolved.deploymentId;
    await escalate({ deploymentId, laneName, reason: 'evaluation-indeterminate' });
    return {
      kind: 'refused',
      governed: true,
      laneName,
      reason: 'evaluation-indeterminate',
    };
  }

  const inputs = resolved.inputs;
  const resolvedSet = resolveForMode(inputs.laneSet, inputs.mode);
  const assignment = assignLane(resolvedSet, classifierVerdict);
  const laneName = assignment.lane;
  const assignedLane = resolvedSet.lanes.find((l) => l.name === laneName);

  const status = observeVerifierStatus(assignedLane?.verifier, { probeOracle });
  const verdict = evaluateVerifierGate(assignedLane?.verifier, status);

  if (verdict.kind === 'verifier-gated') {
    await implement();
    return { kind: 'proceeded', governed: true, laneName };
  }

  await escalate({ deploymentId, laneName, reason: verdict.reason });
  return { kind: 'refused', governed: true, laneName, reason: verdict.reason };
}

export function createPhaseHandlers(
  config: Config,
  owner: string,
  repoName: string,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  octokit: Octokit,
  workRequest: WorkRequest,
  stateDir: string,
  runWriter?: RunWriter,
  runId?: string,
  repoRoot?: string,
  activePlugins?: Array<{ id: string; activatedAt: string }>,
  knowledgeStore?: KnowledgeStore,
  phaseLabelMirror?: PhaseLabelMirror,
  decisionManager?: DecisionIndexManager,
  decisionPublisher?: GitHubBlockPublisher,
  // OPTIONAL deployment registry — the config source the merge-decision live
  // wiring reads (slice 5b). When undefined (today's call sites + the flag-OFF
  // path), the `integrate` handler keeps its unconditional integrateToStaging
  // (byte-identical to pre-5b). Kimi wires the `integrate` handler body to read
  // `registry` + `run.deploymentId`; this gate only adds the OPTIONAL param so
  // the wiring integration test can inject a registry while existing call sites
  // (which omit it) still compile.
  registry?: DeploymentRegistry,
  // OPTIONAL input-boundary sanitization pipeline. Default = identity, keeping
  // the raise path byte-identical when no deployment configures sanitizers.
  sanitizationPipeline?: SanitizationPipeline,
  // OPTIONAL detect-settled signal (gap #6 — detect dispatch serialization). Fired
  // in the `detect` handler's `finally` AFTER the repo git lock is released
  // (release-before-signal). The daemon threads a per-run idempotent gate-release
  // here so the repo's detect gate frees the moment detect settles — preserving
  // post-detect concurrency and letting the next FIFO-queued detect proceed
  // without false contention. Omitted for website / non-detect entrants.
  onDetectSettled?: () => void,
  // P0.5 pause gate: if the daemon is paused when a run reaches integrate-entry,
  // park the run instead of merging. Resumes via the existing integrate arm of
  // resumeParkedRuns after /resume.
  isPaused?: () => boolean,
  // P3.3 operator alert: fired once when a decision-raise notify transition applies.
  alert?: DecisionRaisedAlert,
): PhaseHandlerMap {
  const repo = repoName;
  // Lazily constructed only when the decision index is enabled — a disabled
  // deployment never builds it (flag-OFF behavior stays byte-identical).
  const resolveDecisionPublisher = (): GitHubBlockPublisher =>
    decisionPublisher ?? new GitHubBlockPublisher();
  const detector = createWorkDetector(octokit, owner, repo);
  const featureBranch = `feature/${workRequest.issueNumber}`;
  // Workspace isolation: sessions run in a worktree, not the daemon's own directory.
  // This prevents `git checkout` from swapping the daemon's source code out from under it.
  const mainRepoRoot = repoRoot ?? process.cwd();
  const workspaceDir = join(
    mainRepoRoot,
    'workspaces',
    `issue-${workRequest.issueNumber}`,
  );
  // After detect, all phases use workspaceCwd instead of repoRoot.
  // Restored from run.workspacePath on resume (survives daemon restarts).
  let workspaceCwd: string = mainRepoRoot;
  let workspaceRestored = false;

  // Default pipeline is the identity (empty). Callers that omit it stay on the
  // byte-identical raise path; configured deployments pass a real pipeline.
  const pipeline = sanitizationPipeline ?? new SanitizationPipeline([]);

  /**
   * Apply the input-boundary sanitization pipeline to a DecisionRequest before
   * it is raised. When the pipeline is empty the original request is returned
   * unchanged, preserving today's raise path.
   */
  async function sanitizeDecisionRequest(
    request: DecisionRequest,
  ): Promise<DecisionRequest> {
    return applyDecisionSanitization(pipeline, request);
  }

  // ---------------------------------------------------------------------------
  // P1 controlled code-change delivery helpers
  // ---------------------------------------------------------------------------

  function isLandingTarget(value: unknown): value is {
    landsOn: string;
    requiredChecks?: string[];
  } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'landsOn' in value &&
      typeof (value as Record<string, unknown>).landsOn === 'string' &&
      (value as Record<string, unknown>).landsOn !== ''
    );
  }

  function readLandingTarget(
    deploymentId: string,
  ): { landsOn: string; requiredChecks: string[] } | undefined {
    if (registry === undefined) return undefined;
    const declared = registry.readDeclaredData(deploymentId, 'landing');
    if (declared.kind !== 'found' || !isLandingTarget(declared.value)) {
      return undefined;
    }
    return {
      landsOn: declared.value.landsOn,
      requiredChecks: declared.value.requiredChecks ?? [],
    };
  }

  function getOrCreateIntegrateArtifact(
    run: RunState,
    landsOn: string,
  ): PhaseArtifact {
    const now = new Date().toISOString();
    const existing = run.phaseArtifacts?.integrate;
    if (existing !== undefined) {
      return existing;
    }
    const artifact: PhaseArtifact = {
      issueNumber: workRequest.issueNumber,
      phase: 'integrate',
      artifactKind: 'pull_request',
      proposalKey: buildProposalKey({
        owner,
        repo,
        issueNumber: workRequest.issueNumber,
        phase: 'integrate',
        baseBranch: landsOn,
      }),
      artifactPaths: [],
      headBranch: featureBranch,
      baseBranch: landsOn,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    run.phaseArtifacts = { ...(run.phaseArtifacts ?? {}), integrate: artifact };
    return artifact;
  }

  async function pushFeatureBranch({
    featureBranch: branch,
  }: {
    owner: string;
    repo: string;
    featureBranch: string;
    landsOn: string;
  }): Promise<{ pushed: boolean; error?: string }> {
    const result = await git(['push', 'origin', branch], mainRepoRoot);
    if (!result.ok) {
      return { pushed: false, error: result.error.message };
    }
    return { pushed: true };
  }

  /**
   * Map the legacy classifier complexity onto the lane-engine RiskLevel floor.
   * Simple work is the least cautious; complex work is the most cautious.
   * Unknown/absent complexity falls back to the most cautious level (fail-safe).
   */
  const classifierLevelFromComplexity = (
    complexity: ClassificationComplexity | undefined,
  ): RiskLevel => {
    switch (complexity) {
      case 'simple':
        return 'green';
      case 'standard':
        return 'yellow';
      case 'complex':
        return 'red';
      default:
        return 'red';
    }
  };

  /** Restore workspaceCwd from persisted run state if not already set. */
  const ensureWorkspace = async (run: RunState) => {
    if (workspaceRestored || workspaceCwd !== mainRepoRoot) return;
    if (run.workspacePath) {
      const { existsSync } = await import('node:fs');
      if (existsSync(run.workspacePath)) {
        workspaceCwd = run.workspacePath;
        console.log(
          `[phases] Restored workspace from run state: ${workspaceCwd}`,
        );
      } else {
        console.warn(
          `[phases] Persisted workspace ${run.workspacePath} gone — using repo root`,
        );
      }
    }
    workspaceRestored = true;
  };

  const recordDeliveryFailure = (
    run: RunState,
    phase: DeliverableSpecPhase,
    error: Error,
  ): PhaseEvent => {
    const kind =
      error instanceof DeliveryError ? error.kind : 'delivery-repair-needed';
    run.lastFailure = createFailureRecord({
      kind,
      phase,
      message: error.message,
      severity: 'blocking',
      retryable: true,
      repairAction:
        kind === 'agent-output-invalid'
          ? 'retry-session'
          : 'reconcile-artifact',
    });
    return 'failure';
  };

  const recreateWorkspaceFromRef = async (
    run: RunState,
    phase: DeliverableSpecPhase,
    sourceRef: string,
  ): Promise<PhaseEvent | undefined> => {
    const removed = await git(
      ['worktree', 'remove', '--force', workspaceDir],
      mainRepoRoot,
    );
    if (!removed.ok) {
      await git(['worktree', 'prune'], mainRepoRoot);
    }

    const created = await git(
      ['worktree', 'add', '-B', featureBranch, workspaceDir, sourceRef],
      mainRepoRoot,
    );
    if (!created.ok) {
      run.lastFailure = createFailureRecord({
        kind: 'workspace-repair-needed',
        phase,
        message: `Failed to recreate workspace from ${sourceRef}: ${created.error.message}`,
        severity: 'blocking',
        retryable: true,
        repairAction: 'recreate-workspace',
      });
      return 'failure';
    }

    workspaceCwd = workspaceDir;
    workspaceRestored = true;
    run.workspacePath = workspaceDir;
    return undefined;
  };

  const refreshSpecRefsAfterArtifact = async (run: RunState) => {
    try {
      run.specRefs = await resolveCurrentSpecRefs(
        workspaceCwd,
        workRequest.specRefs,
      );
    } catch (e) {
      console.warn(
        `[artifact] Failed to refresh spec refs after reconciliation:`,
        e,
      );
    }
  };

  /**
   * Merge a phase proposal PR (squash). The operator's gate approval authorizes
   * the merge, so the daemon performs it rather than waiting for a manual merge.
   * Returns a failure reason (never throws) so the caller can re-park gracefully
   * when the PR is genuinely un-mergeable (conflicts / required checks).
   */
  const mergeL2Proposal = async (
    prNumber: number | undefined,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (prNumber === undefined) {
      return { ok: false, reason: 'no proposal PR recorded' };
    }
    try {
      await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: 'squash',
      });
      console.log(
        `[l2-gate] auto-merged L2 proposal PR #${prNumber} on approval`,
      );
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(
        `[l2-gate] auto-merge of L2 proposal PR #${prNumber} failed: ${reason}`,
      );
      return { ok: false, reason };
    }
  };

  const reconcileDeliveredArtifact = async (
    run: RunState,
    phase: DeliverableSpecPhase,
  ): Promise<PhaseArtifactReconcileOutcome> => {
    const reconciled = await reconcilePhaseArtifact({
      owner,
      repo,
      phase,
      artifact: run.phaseArtifacts?.[phase],
      repoRoot: mainRepoRoot,
      octokit,
    });
    if (!reconciled.ok) {
      console.error(
        `[${phase}] Artifact reconciliation failed:`,
        reconciled.error.message,
      );
      return {
        kind: 'event',
        event: recordDeliveryFailure(run, phase, reconciled.error),
      };
    }

    run.phaseArtifacts = {
      ...(run.phaseArtifacts ?? {}),
      [phase]: reconciled.value.artifact,
    };
    if (reconciled.value.status !== 'merged') {
      return { kind: 'status', status: reconciled.value.status };
    }

    const resumeRef = reconciled.value.resumeRef;
    if (resumeRef === undefined || resumeRef.length === 0) {
      return {
        kind: 'event',
        event: recordDeliveryFailure(
          run,
          phase,
          new DeliveryError(
            'delivery-repair-needed',
            `Merged ${phase} artifact did not provide a resume ref`,
          ),
        ),
      };
    }

    const refreshed = await recreateWorkspaceFromRef(run, phase, resumeRef);
    if (refreshed !== undefined) return { kind: 'event', event: refreshed };
    await refreshSpecRefsAfterArtifact(run);
    return { kind: 'status', status: 'merged' };
  };

  const mergeDeliveredArtifact = async (
    run: RunState,
    phase: DeliverableSpecPhase,
  ): Promise<PhaseArtifactReconcileOutcome> => {
    const merged = await mergePhaseArtifact({
      owner,
      repo,
      phase,
      artifact: run.phaseArtifacts?.[phase],
      repoRoot: mainRepoRoot,
      octokit,
      commitTitle: `${phase === 'l2-design' ? 'L2' : 'L3'} spec artifacts for #${workRequest.issueNumber}`,
      commitMessage: `Daemon-owned ${phase} artifact delivery for #${workRequest.issueNumber}.`,
    });
    if (!merged.ok) {
      console.error(`[${phase}] Artifact merge failed:`, merged.error.message);
      return {
        kind: 'event',
        event: recordDeliveryFailure(run, phase, merged.error),
      };
    }

    run.phaseArtifacts = {
      ...(run.phaseArtifacts ?? {}),
      [phase]: merged.value.artifact,
    };
    if (merged.value.status !== 'merged') {
      return { kind: 'status', status: merged.value.status };
    }

    const resumeRef = merged.value.resumeRef;
    if (resumeRef === undefined || resumeRef.length === 0) {
      return {
        kind: 'event',
        event: recordDeliveryFailure(
          run,
          phase,
          new DeliveryError(
            'delivery-repair-needed',
            `Merged ${phase} artifact did not provide a resume ref`,
          ),
        ),
      };
    }

    const refreshed = await recreateWorkspaceFromRef(run, phase, resumeRef);
    if (refreshed !== undefined) return { kind: 'event', event: refreshed };
    await refreshSpecRefsAfterArtifact(run);
    return { kind: 'status', status: 'merged' };
  };

  const mergeL3ArtifactIfPresent = async (
    run: RunState,
  ): Promise<PhaseEvent> => {
    if (run.phaseArtifacts?.['l3-generate'] === undefined) {
      console.warn(
        `[l3-compliance] No recorded L3 artifact found — continuing without daemon merge`,
      );
      return 'success';
    }

    const merged = await mergeDeliveredArtifact(run, 'l3-generate');
    if (merged.kind === 'event') return merged.event;
    if (merged.status !== 'merged') {
      return recordDeliveryFailure(
        run,
        'l3-generate',
        new DeliveryError(
          'delivery-repair-needed',
          `L3 artifact proposal status is ${merged.status}; expected merged before implementation`,
        ),
      );
    }
    return 'success';
  };

  const packageSpecArtifact = async (
    run: RunState,
    phase: DeliverableSpecPhase,
    cwd: string,
  ): Promise<PhaseEvent> => {
    const delivery = await deliverPhaseArtifact({
      owner,
      repo,
      issueNumber: workRequest.issueNumber,
      issueTitle: workRequest.title,
      phase,
      workspacePath: cwd,
      baseBranch: config.branches.staging,
      octokit,
    });
    if (!delivery.ok) {
      console.error(
        `[${phase}] Artifact delivery failed:`,
        delivery.error.message,
      );
      return recordDeliveryFailure(run, phase, delivery.error);
    }
    run.phaseArtifacts = {
      ...(run.phaseArtifacts ?? {}),
      [phase]: delivery.value.artifact,
    };
    return 'success';
  };

  return {
    detect: async (run: RunState): Promise<PhaseEvent> => {
      if (!acquireRepoGitLock()) {
        // GATE BYPASS (gap #6): the daemon's dispatch gate serializes detect so two
        // detects can no longer legally overlap in-process. A contended lock HERE
        // means the gate was bypassed — a loud structured fault, NOT routine
        // workspace repair. Do NOT route as `workspace-repair-needed` /
        // `recreate-workspace` (that destructive path is reserved for genuine
        // reconcileWorkspace failures); surface the invariant violation instead.
        console.error(
          `[detect] CONTENDED despite dispatch serialization — possible concurrent shared-worktree mutation`,
          { feature: featureBranch },
        );
        return 'failure';
      }
      try {
        console.log(
          `[detect] Reconciling workspace ${workspaceDir} for ${featureBranch} from ${config.branches.staging}`,
        );
        // Fast-forward the local base to origin BEFORE branching the worktree off
        // it, so externally-pushed specs are visible (the daemon otherwise only
        // fetches when IT merges). Best-effort: never fails detect — a fetch/FF
        // problem just leaves the prior (local) base in place.
        const baseRef = config.runtimeSource.expectedRef ?? config.branches.staging;
        const refreshed = await ensureRepoFresh(mainRepoRoot, baseRef);
        if (!refreshed.ok) {
          console.warn(
            `[detect] ensureRepoFresh(${baseRef}) failed (continuing with local base): ${refreshed.error.message}`,
          );
        }
        // Post-gate assertion (gap #6): the repo git lock MUST be held across the
        // checkout-mutating reconcileWorkspace call. If it is not, the dispatch
        // serialization invariant was violated — surface it loudly so a hidden
        // concurrent shared-worktree mutation cannot be silently masked.
        if (!isRepoGitLocked()) {
          console.error(
            `[detect] reconcileWorkspace invoked WITHOUT the repo git lock held — serialization invariant violated`,
            { feature: featureBranch },
          );
        }
        console.log(`[detect] reconcileWorkspace start for ${featureBranch}`);
        const reconciled = await reconcileWorkspace({
          repoRoot: mainRepoRoot,
          workspaceDir,
          featureBranch,
          stagingBranch: config.branches.staging,
          sourceRef: config.runtimeSource.expectedRef,
        });
        console.log(
          `[detect] reconcileWorkspace done for ${featureBranch} (ok=${reconciled.ok})`,
        );
        if (!reconciled.ok) {
          console.error(
            `[detect] Workspace reconcile failed:`,
            reconciled.error.message,
          );
          run.lastFailure = createFailureRecord({
            kind: 'workspace-repair-needed',
            phase: 'detect',
            message: reconciled.error.message,
            severity: 'blocking',
            retryable: true,
            repairAction: 'recreate-workspace',
          });
          return 'failure';
        }
        workspaceCwd = reconciled.value.path;
        run.workspacePath = reconciled.value.path; // Persist for daemon restart recovery
        return 'success';
      } finally {
        // Release-before-signal (gap #6 — load-bearing order): free the repo git
        // lock FIRST, THEN signal the daemon's detect gate. If onDetectSettled
        // launched the next FIFO-queued crash-resume detect before the lock was
        // released, that detect would hit acquireRepoGitLock() while the old lock
        // is still held → false contention. Early release preserves post-detect
        // concurrency.
        releaseRepoGitLock();
        onDetectSettled?.();
      }
    },

    // --- Spec-driven pipeline phase handlers ---

    'l2-design': async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[l2-design] Generating L2 architecture spec for #${workRequest.issueNumber}`,
      );
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      let specContent = '';
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[l2-design] Failed to load spec content:`, e);
      }
      const result = await runtime.spawnSession(
        'l2-designer',
        {
          variables: {
            issueNumber: String(workRequest.issueNumber),
            issueTitle: workRequest.title,
            issueBody: workRequest.body,
            specContent,
            owner,
            repo: repoName,
            feedback: run.l2Feedback ?? '',
          },
          workspacePath: cwd,
        },
        workRequest.issueNumber,
        undefined,
        runWriter,
        runId,
      );
      run.l2Feedback = undefined;
      if (!result.ok) {
        console.error(`[l2-design] Session failed: ${result.error.message}`);
        return 'failure';
      }
      if (
        result.value.exitStatus === 'timed-out' ||
        result.value.exitStatus === 'failed'
      ) {
        console.error(
          `[l2-design] Session exited with status: ${result.value.exitStatus}`,
        );
        return 'failure';
      }
      // Refresh spec refs after L2 design session generates new specs
      try {
        run.specRefs = await resolveCurrentSpecRefs(cwd, workRequest.specRefs);
      } catch (e) {
        console.warn(`[l2-design] Failed to refresh spec refs:`, e);
      }
      return packageSpecArtifact(run, 'l2-design', cwd);
    },

    'l2-gate': async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[l2-gate] Checking L2 gate labels for #${workRequest.issueNumber}`,
      );
      // Fetch current issue labels
      let labels: string[];
      try {
        const response = await octokit.issues.get({
          owner,
          repo,
          issue_number: workRequest.issueNumber,
        });
        labels = (
          response.data.labels as Array<{ name?: string } | string>
        ).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      } catch (e) {
        console.error(`[l2-gate] Failed to fetch issue labels:`, e);
        return 'failure';
      }

      if (labels.includes('l2-approved')) {
        console.log(`[l2-gate] L2 approved for #${workRequest.issueNumber}`);
        let reconciled = await reconcileDeliveredArtifact(run, 'l2-design');
        if (reconciled.kind === 'event') return reconciled.event;
        if (reconciled.status !== 'merged') {
          // Approval authorizes the merge: the operator approved the L2 spec at
          // the gate, so auto-merge the recorded proposal PR and re-reconcile.
          // Without this the run re-parks forever waiting for a manual merge (#49).
          const merged = await mergeL2Proposal(
            run.phaseArtifacts?.['l2-design']?.pullRequestNumber,
          );
          if (merged.ok) {
            reconciled = await reconcileDeliveredArtifact(run, 'l2-design');
            if (reconciled.kind === 'event') return reconciled.event;
          }
          if (reconciled.status !== 'merged') {
            // Genuinely cannot proceed (no PR recorded, or merge blocked by
            // conflicts / required checks) — re-park with an actionable message.
            run.pausedAtPhase = 'l2-gate';
            if (run.l2MergeBlockedNotified !== true) {
              const artifactUrl =
                run.phaseArtifacts?.['l2-design']?.pullRequestUrl;
              const proposalLine =
                artifactUrl !== undefined && artifactUrl.length > 0
                  ? `\n\nProposal: ${artifactUrl}`
                  : '';
              const reasonLine = merged.ok
                ? ''
                : `\n\nAuto-merge failed: ${merged.reason}`;
              try {
                await octokit.issues.createComment({
                  owner,
                  repo,
                  issue_number: workRequest.issueNumber,
                  body:
                    `## L2 Proposal Not Merged\n\nThe \`l2-approved\` label is present, ` +
                    `but the L2 proposal could not be auto-merged into ` +
                    `\`${config.branches.staging}\`. Resolve any conflicts or failing ` +
                    `checks and merge it, then re-apply \`l2-approved\`.` +
                    `${reasonLine}${proposalLine}`,
                });
              } catch (e) {
                console.warn(`[l2-gate] Failed to notify merge block:`, e);
              }
              run.l2MergeBlockedNotified = true;
            }
            return 'success';
          }
        }
        run.pausedAtPhase = undefined;
        run.l2MergeBlockedNotified = undefined;
        return 'success';
      }
      if (labels.includes('l2-rejected')) {
        console.log(
          `[l2-gate] L2 rejected for #${workRequest.issueNumber} — looping back to l2-design`,
        );
        // Fetch the most recent rejection comment to pass as feedback to the designer
        try {
          const comments = await octokit.issues.listComments({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            per_page: 20,
          });
          const rejectionComment = [...comments.data]
            .reverse()
            .find(
              (c) =>
                c.body?.includes('REJECTED') || c.body?.includes('l2-rejected'),
            );
          if (rejectionComment?.body) {
            // Sanitize before storing: strip {{placeholder}} patterns (defense against
            // template injection via renderTemplate) and cap length to limit prompt size.
            const MAX_FEEDBACK_LENGTH = 4000;
            run.l2Feedback = rejectionComment.body
              .replace(/\{\{[\w-]+\}\}/g, '')
              .slice(0, MAX_FEEDBACK_LENGTH);
            console.log(
              `[l2-gate] Captured rejection feedback for #${workRequest.issueNumber}`,
            );
          }
        } catch (e) {
          console.warn(`[l2-gate] Failed to fetch rejection comment:`, e);
        }
        // Remove l2-rejected label so next gate check doesn't re-trigger immediately
        try {
          await octokit.issues.removeLabel({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            name: 'l2-rejected',
          });
        } catch (e) {
          console.warn(`[l2-gate] Failed to remove l2-rejected label:`, e);
        }
        run.l2GateNotified = false;
        run.l2MergeBlockedNotified = undefined;
        // A rework cycle starts a NEW decision epoch (new deterministic id), so the
        // next park must re-publish a fresh block. Clear the published flag here
        // (enabled-only, so a flag-OFF feedback path stays byte-identical).
        if (decisionManager?.isEnabled() === true) {
          run.decisionBlockPublished = false;
        }
        return 'feedback';
      }
      // Neither approved nor rejected — park the run
      console.log(
        `[l2-gate] No L2 decision yet for #${workRequest.issueNumber} — parking`,
      );
      run.pausedAtPhase = 'l2-gate';
      // First park: bump the decision epoch (a fresh review cycle), add label,
      // post comment, and — when the decision index is enabled — raise+notify a
      // DecisionRequest. The epoch bump happens ONLY on a fresh park (guarded by
      // l2GateNotified) so per-tick re-scans of an already-parked run keep the
      // same epoch (and therefore the same deterministic decision id).
      if (!run.l2GateNotified) {
        try {
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            labels: ['awaiting-l2-review'],
          });
          const artifactUrl = run.phaseArtifacts?.['l2-design']?.pullRequestUrl;
          const deliverable =
            artifactUrl !== undefined && artifactUrl.length > 0
              ? `\n\nReview proposal: ${artifactUrl}`
              : '';
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            body: `## Awaiting L2 Review\n\nThe L2 architecture spec is ready for review.${deliverable}\n\nAdd the \`l2-approved\` label to continue, or \`l2-rejected\` to send back for revision.`,
          });
        } catch (e) {
          console.error(`[l2-gate] Failed to notify:`, e);
        }
        run.decisionEpoch = (run.decisionEpoch ?? 0) + 1;
        run.l2GateNotified = true;
        // A fresh park starts a fresh emission attempt for THIS epoch. Only touch
        // the flag when the index is enabled so a flag-OFF park stays byte-identical
        // to pre-Slice-1 behavior (no new RunState field written). The rework path
        // also clears it (a new epoch must re-publish).
        if (decisionManager?.isEnabled() === true) {
          run.decisionBlockPublished = false;
        }
      }

      // Emit the DecisionRequest to the cockpit inbox (additive, flag-gated).
      // This is the single physical wire daemon -> cockpit: raise the request,
      // EMBED its canonical block into the gate issue BODY + apply the decision
      // label (the surface the cockpit's issue-poller actually reads), THEN notify
      // the local index lifecycle. The order is deliberate (raise -> publish ->
      // notify): notify advances detected->notified, and we only claim the local
      // row is notified once the cockpit-facing block is durably published.
      //
      // RETRYABLE (no latch-out): this runs on EVERY parked scan until the block
      // is confirmed published (`run.decisionBlockPublished`), NOT once-only —
      // so a transient GitHub/ledger failure is retried next tick instead of
      // being lost behind the `l2GateNotified` one-shot guard. The deterministic
      // decision_id + idempotent body embed make repeated raise/publish/notify
      // safe (raise is idempotent on the id, ensure() is a no-op when the body is
      // already identical, notify() no-ops past `detected`).
      //
      // FAIL-CLOSED: any ledger throw OR a non-posted publish leaves the run
      // parked, does NOT mark the block published, and does NOT notify — it must
      // never crash the gate handler.
      if (
        decisionManager?.isAvailable() === true &&
        run.decisionEpoch !== undefined &&
        run.decisionBlockPublished !== true
      ) {
        try {
          const ledger = decisionManager.ledger();
          const request = buildL2GateRequest(
            run,
            run.decisionEpoch,
            `${owner}/${repo}`,
          );
          const sanitized = await sanitizeDecisionRequest(request);
          const { decision_id } = await ledger.raise(sanitized);
          const published = await resolveDecisionPublisher().ensure({
            request: sanitized,
            octokit,
            owner,
            repo,
            issueNumber: workRequest.issueNumber,
          });
          if (published.posted) {
            await alertOnNotifyApplied(
              () => ledger.notify(decision_id),
              alert,
              {
                issueNumber: workRequest.issueNumber,
                decisionId: decision_id,
                title: sanitized.question,
                dashboardBaseUrl: config.dashboardBaseUrl,
              },
            );
            run.decisionBlockPublished = true;
          } else {
            console.warn(
              `[l2-gate] decision block not published for #${workRequest.issueNumber} (${published.reason ?? 'unknown'}) — staying parked, will retry`,
            );
          }
        } catch (e) {
          console.warn(
            `[l2-gate] decision-index raise/publish/notify failed (failing closed, run stays parked): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return 'success';
    },

    'l3-generate': async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[l3-generate] Generating L3 stack spec for #${workRequest.issueNumber}`,
      );

      // Operator override: if the L3 spec was already operator-approved
      // (l3-approved label) OR a human-authored L3 file already exists in the
      // staging branch's .specify/stack/, skip regeneration. Same rationale as
      // the l3-compliance bypass: re-running the generator on every pipeline
      // cycle clobbers carefully-authored specs with model output that the
      // compliance reviewer then rejects, looping forever. The bypass also
      // saves substantial token spend.
      try {
        const labelResp = await octokit.issues.get({
          owner,
          repo,
          issue_number: workRequest.issueNumber,
        });
        const labelNames = (
          labelResp.data.labels as Array<{ name?: string } | string>
        ).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
        if (labelNames.includes('l3-approved')) {
          console.log(
            `[l3-generate] L3 already operator-approved for #${workRequest.issueNumber} — skipping generator`,
          );
          return 'success';
        }
      } catch (e) {
        console.warn(
          `[l3-generate] Failed to fetch labels for bypass check:`,
          e,
        );
        // Fall through to generation.
      }

      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      // Refresh spec refs before generation to pick up L2 specs
      try {
        run.specRefs = await resolveCurrentSpecRefs(cwd, workRequest.specRefs);
      } catch (e) {
        console.warn(
          `[l3-generate] Failed to refresh spec refs before generation:`,
          e,
        );
      }
      let specContent = '';
      try {
        specContent = await loadSpecContent(
          run.specRefs ?? workRequest.specRefs,
          specifyRoot,
        );
      } catch (e) {
        console.warn(`[l3-generate] Failed to load spec content:`, e);
      }
      const result = await runtime.spawnSession(
        'l3-generator',
        {
          variables: {
            issueNumber: String(workRequest.issueNumber),
            issueTitle: workRequest.title,
            issueBody: workRequest.body,
            specContent,
            owner,
            repo: repoName,
            feedback: run.l3Feedback ?? '',
          },
          workspacePath: cwd,
        },
        workRequest.issueNumber,
        undefined,
        runWriter,
        runId,
      );
      if (!result.ok) {
        console.error(`[l3-generate] Session failed: ${result.error.message}`);
        // Retain l3Feedback so the retry attempt sees the same compliance findings
        // (Codex review 636ca05 — clearing before failure check loses feedback on
        //  transient l3-generate self-loop retries).
        return 'failure';
      }
      if (
        result.value.exitStatus === 'timed-out' ||
        result.value.exitStatus === 'failed'
      ) {
        console.error(
          `[l3-generate] Session exited with status: ${result.value.exitStatus}`,
        );
        return 'failure';
      }
      // Generator produced an accepted result — clear feedback so the next
      // compliance failure starts a fresh round (l3-compliance success path
      // also clears this; double-clear is safe).
      run.l3Feedback = undefined;
      // Refresh spec refs after L3 generation
      try {
        run.specRefs = await resolveCurrentSpecRefs(cwd, workRequest.specRefs);
      } catch (e) {
        console.warn(
          `[l3-generate] Failed to refresh spec refs after generation:`,
          e,
        );
      }
      return packageSpecArtifact(run, 'l3-generate', cwd);
    },

    'l3-compliance': async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[l3-compliance] Reviewing L3 compliance for #${workRequest.issueNumber}`,
      );

      // Operator override: same pattern as l2-gate. If the L3 spec was already
      // approved by a human (l3-approved label present), don't second-guess via
      // the autonomous compliance reviewer. Without this bypass, the daemon
      // re-runs l3-generate + l3-compliance every time the pipeline restarts,
      // and the reviewer often catches real cross-layer concerns the regenerator
      // can't fix because they require L1/L2 changes (read-only to the worker).
      try {
        const labelResp = await octokit.issues.get({
          owner,
          repo,
          issue_number: workRequest.issueNumber,
        });
        const labelNames = (
          labelResp.data.labels as Array<{ name?: string } | string>
        ).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
        if (labelNames.includes('l3-approved')) {
          console.log(
            `[l3-compliance] L3 already operator-approved for #${workRequest.issueNumber} — bypassing reviewer`,
          );
          run.l3ComplianceAttempts = undefined;
          run.l3Feedback = undefined;
          return mergeL3ArtifactIfPresent(run);
        }
      } catch (e) {
        console.warn(
          `[l3-compliance] Failed to fetch labels for bypass check:`,
          e,
        );
        // Fall through to running the reviewer.
      }

      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      let specContent = '';
      try {
        specContent = await loadSpecContent(
          run.specRefs ?? workRequest.specRefs,
          specifyRoot,
        );
      } catch (e) {
        console.warn(`[l3-compliance] Failed to load spec content:`, e);
      }

      const result = await runtime.spawnSession(
        'compliance-reviewer',
        {
          variables: {
            issueNumber: String(workRequest.issueNumber),
            issueTitle: workRequest.title,
            issueBody: workRequest.body,
            specContent,
            owner,
            repo: repoName,
          },
          workspacePath: cwd,
        },
        workRequest.issueNumber,
        { jsonSchema: complianceReportJsonSchema },
        runWriter,
        runId,
      );

      // Helper: every failure path must increment the counter and check the cap.
      const recordFailureAndMaybeEscalate = (feedback?: string): PhaseEvent => {
        if (feedback !== undefined) {
          const MAX_FEEDBACK_LENGTH = 4000;
          run.l3Feedback = feedback
            .replace(/\{\{[\w-]+\}\}/g, '')
            .slice(0, MAX_FEEDBACK_LENGTH);
        }
        run.l3ComplianceAttempts = (run.l3ComplianceAttempts ?? 0) + 1;
        const MAX_L3_COMPLIANCE_ATTEMPTS = 3;
        if (run.l3ComplianceAttempts >= MAX_L3_COMPLIANCE_ATTEMPTS) {
          console.error(
            `[l3-compliance] Exhausted ${MAX_L3_COMPLIANCE_ATTEMPTS} attempts — escalating to stuck`,
          );
          return 'escalated';
        }
        return 'failure';
      };

      if (!result.ok) {
        console.error(
          `[l3-compliance] Session failed: ${result.error.message}`,
        );
        return recordFailureAndMaybeEscalate(
          `Compliance session error: ${result.error.message}`,
        );
      }
      if (
        result.value.exitStatus === 'timed-out' ||
        result.value.exitStatus === 'failed'
      ) {
        console.error(
          `[l3-compliance] Session exited with status: ${result.value.exitStatus}`,
        );
        return recordFailureAndMaybeEscalate(
          `Compliance session ended with exit status: ${result.value.exitStatus}`,
        );
      }

      // Extract compliance payload. Try wrapper unwrap first (preferred path
      // when --json-schema produced structured_output). Then if `compliant` is
      // missing, fall back to parsing JSON from result text (model didn't honor
      // the schema and returned a markdown code block or bare JSON instead).
      // Without the fallback, a noncompliant report can silently pass when
      // structured_output is null (Codex deep review of fix/silent-prompt-vars).
      type CompliancePayload = {
        compliant?: boolean;
        findings?: Array<{
          type?: string;
          severity?: string;
          location?: string;
          description?: string;
        }>;
        summary?: string;
      };
      const rawData = result.value?.structuredData;
      let payload = extractStructuredOutput(rawData) as
        | CompliancePayload
        | undefined;
      if (typeof payload?.compliant !== 'boolean') {
        const rd = rawData as Record<string, unknown> | null;
        const resultText =
          typeof rd?.['result'] === 'string'
            ? (rd['result'] as string)
            : (result.value?.output ?? '');
        const jsonMatch =
          resultText.match(/```json\s*([\s\S]*?)```/s) ??
          resultText.match(/(\{[\s\S]*\})/s);
        if (jsonMatch?.[1]) {
          try {
            payload = JSON.parse(jsonMatch[1]) as CompliancePayload;
          } catch {
            /* fall through */
          }
        }
      }

      // Defensive: treat absent or non-boolean `compliant` as failure rather
      // than silently passing. The compliance gate exists to block bad specs;
      // a malformed reply must not earn a free pass.
      if (typeof payload?.compliant !== 'boolean') {
        const preview = (JSON.stringify(payload) ?? '<undefined>').slice(
          0,
          500,
        );
        console.error(
          `[l3-compliance] Compliance reply missing or malformed 'compliant' field — treating as failure`,
        );
        return recordFailureAndMaybeEscalate(
          `Compliance session returned malformed output (compliant field missing or non-boolean). ` +
            `Raw payload preview: ${preview}`,
        );
      }

      if (payload.compliant === false) {
        const findingLines = (payload.findings ?? [])
          .map(
            (f) =>
              `- [${f.severity ?? 'unknown'}] ${f.location ?? ''}: ${f.description ?? ''}`,
          )
          .join('\n');
        const feedback = `Compliance findings:\n${findingLines}\n\n${payload.summary ?? ''}`;
        console.log(
          `[l3-compliance] Compliance failed — captured ${payload.findings?.length ?? 0} findings`,
        );
        return recordFailureAndMaybeEscalate(feedback);
      }

      // Success path — clear counter and any stale feedback so the next round starts fresh.
      run.l3ComplianceAttempts = undefined;
      run.l3Feedback = undefined;
      return mergeL3ArtifactIfPresent(run);
    },

    decompose: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[decompose] Decompose phase for #${workRequest.issueNumber} — pass-through`,
      );
      return 'success';
    },

    // --- Standard pipeline phase handlers ---

    classify: async (run: RunState): Promise<PhaseEvent> => {
      if (workRequest.preClassification) {
        console.log(
          `[classify] Using pre-classification for #${workRequest.issueNumber}`,
        );
        run.classificationComplexity = workRequest.preClassification.complexity;
        run.classifierChangeKind = workRequest.preClassification.changeKind;
        run.classifierScope = workRequest.preClassification.scope;
        return workRequest.preClassification.event;
      }
      console.log(
        `[classify] Classifying work request #${workRequest.issueNumber}`,
      );
      const result = await runClassify(
        runtime,
        workRequest,
        runWriter,
        runId,
        workspaceCwd,
        activePlugins,
      );
      run.classificationComplexity = result.complexity;
      run.classifierChangeKind = result.changeKind;
      run.classifierScope = result.scope;
      return result.event;
    },

    diagnose: async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[diagnose] Running diagnosis for #${workRequest.issueNumber}`,
      );
      const threshold = config.diagnosis.confidenceThreshold;

      // Load actual spec content from .specify/ (not just spec IDs) (#143)
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      let specContent = '';
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[diagnose] Failed to load spec content:`, e);
      }

      // Load implementation content from code_paths in traceability.yml (#263)
      let implementationContent = '';
      try {
        implementationContent = await loadImplementationContent(
          workRequest.specRefs,
          cwd,
        );
      } catch (e) {
        console.warn(`[diagnose] Failed to load implementation content:`, e);
      }

      const result = await diagnose(
        runtime,
        workRequest.issueNumber,
        workRequest.body,
        implementationContent,
        specContent,
        runWriter,
        runId,
        workspaceCwd,
        activePlugins,
      );

      if (!result.ok) {
        // Extract safety signals from SessionError before falling back (ARCH-AC-OPERATIONAL-SAFETY)
        if (result.error instanceof SessionError) {
          if (result.error.rateLimited) {
            console.warn(
              `[diagnose] Diagnosis session rate-limited: ${result.error.message} — signaling pipeline to pause`,
            );
            return 'rate-limited';
          }
          if (result.error.containmentBreach) {
            console.warn(
              `[diagnose] Diagnosis session containment breach: ${result.error.message} — signaling pipeline`,
            );
            return 'containment-breach';
          }
          // SessionError.budgetExceeded() has cost=0, rateLimited=false, containmentBreach=false —
          // no dedicated boolean, so detect via message prefix (matches factory method format)
          if (result.error.message.startsWith('Budget exceeded')) {
            console.warn(
              `[diagnose] Diagnosis session budget exceeded: ${result.error.message} — signaling pipeline to pause`,
            );
            return 'budget-exceeded';
          }
        }
        console.error(`[diagnose] Diagnosis failed:`, result.error.message);
        // Diagnosis failed — route to human
        try {
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            labels: ['needs-human'],
          });
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            body: `## Diagnosis Failed\n\nAutomatic diagnosis could not produce valid output after retry.\nRouting to human for manual triage.`,
          });
        } catch (e) {
          console.error(`[diagnose] Failed to update issue:`, e);
        }
        return 'failure';
      }

      // Record diagnosis on run state for results ledger + bug-worker context
      run.diagnosisType = result.value.type;
      run.diagnosisConfidence = result.value.confidence;
      run.diagnosisDetail = JSON.stringify(result.value);

      const routing = routeDiagnosis(result.value, threshold);

      if (routing.route === 'bug-pipeline') {
        console.log(
          `[diagnose] Type A (confidence ${result.value.confidence}) — proceeding to implement`,
        );
        return 'success';
      }

      // Type B or Type C / low confidence — post diagnosis and stop
      const diagnosisComment = [
        `## Bug Diagnosis`,
        `**Type:** ${result.value.type} | **Confidence:** ${result.value.confidence}`,
        `**Affected Specs:** ${result.value.affectedSpecs.join(', ') || 'none'}`,
        `**Affected Artifacts:** ${result.value.affectedArtifacts.join(', ') || 'none'}`,
        `**Suggested Action:** ${result.value.suggestedAction}`,
        `**Reasoning:** ${result.value.reasoning}`,
        '',
        routing.route === 'needs-spec-update'
          ? '_Routed to spec author — implementation is correct per spec, but spec is incomplete._'
          : `_Routed to human — ${routing.reason}_`,
      ].join('\n');

      const label =
        routing.route === 'needs-spec-update'
          ? 'needs-spec-update'
          : 'needs-human';
      console.log(`[diagnose] ${routing.route} — labeling ${label}`);

      try {
        await octokit.issues.addLabels({
          owner,
          repo,
          issue_number: workRequest.issueNumber,
          labels: [label],
        });
        await octokit.issues.createComment({
          owner,
          repo,
          issue_number: workRequest.issueNumber,
          body: diagnosisComment,
        });
      } catch (e) {
        console.error(`[diagnose] Failed to update issue:`, e);
      }

      return 'failure';
    },

    implement: async (run: RunState): Promise<PhaseEvent> => {
      console.log(
        `[implement] Starting for #${workRequest.issueNumber} on ${featureBranch}`,
      );
      // Restore persisted handoff notes from RunState for retry attempts (ARCH-AC-HANDOFF step 6)
      const handoffNotes = run.handoffNotes
        ? new Map(Object.entries(run.handoffNotes))
        : undefined;
      // Load spec content so simple-complexity workers receive non-empty {{specs}}
      // (Codex review of fix/worker-context — without this, the new specContent
      // pass-through in createSingleUnitGraph is unreachable from the real
      // production path; the worker keeps getting empty specs).
      await ensureWorkspace(run);
      let cwd = workspaceCwd;
      // Retry attempts: the previous attempt's batch.executeUnit removed the
      // worktree in its finally block, so workspaceCwd may now point to a
      // deleted directory. loadSpecContent silently returns '' when .specify/
      // is missing, which causes the next worker to receive empty specs and
      // burn its budget. Fall back to mainRepoRoot — its .specify/ is always
      // present and reflects the same staging-branch content the worktree
      // would have anyway. Spec changes generated by l2/l3 phases are merged
      // into feature branches and would already be in mainRepoRoot before any
      // implement retry could see them.
      const { existsSync: specifyExists } = await import('node:fs');
      if (!specifyExists(join(cwd, '.specify'))) {
        console.warn(
          `[implement] worktree .specify/ missing at ${cwd} — falling back to mainRepoRoot for spec loading`,
        );
        cwd = mainRepoRoot;
      }
      const specifyRoot = join(cwd, '.specify');
      const effectiveRefs = run.specRefs ?? workRequest.specRefs;
      let specContent = '';
      try {
        specContent = await loadSpecContent(effectiveRefs, specifyRoot);
      } catch (e) {
        console.warn(`[implement] Failed to load spec content:`, e);
      }
      console.log(
        `[implement] specRefs=[${effectiveRefs.join(',')}] specifyRoot=${specifyRoot} specContent.length=${specContent.length}`,
      );
      // #9: an integrate merge-decision REJECT routes back here for rework with
      // the Operator's send-back reason in run.mergeDecisionFeedback. Deliver it on
      // the SAME channel the coordinator already consumes (reviewFindings), tagged
      // so the worker knows it is an operator hold, then clear it (one-shot — later
      // implement retries are driven by review findings, not the original send-back).
      const sendBack = run.mergeDecisionFeedback;
      const implementFindings =
        sendBack !== undefined && sendBack !== ''
          ? [`[operator-send-back] ${sendBack}`, ...(run.reviewFindings ?? [])]
          : run.reviewFindings;
      run.mergeDecisionFeedback = undefined;

      // P2 pre-implement verifier gate: a governed deployment must declare a
      // runnable, falsifying oracle before autonomous implementation is allowed.
      const classifierVerdict: ClassifierVerdict | null =
        run.classificationComplexity !== undefined
          ? {
              complexity: run.classificationComplexity,
              changeKind: run.classifierChangeKind,
              scope: run.classifierScope,
            }
          : null;

      let implementResult:
        | Awaited<ReturnType<typeof coordinator.implement>>
        | undefined;
      const guardResult = await checkVerifierGateBeforeImplement({
        deploymentId: run.deploymentId,
        registry,
        classifierVerdict,
        probeOracle: createProbeOracle(mainRepoRoot),
        implement: async () => {
          implementResult = await coordinator.implement(
            workRequest,
            featureBranch,
            runWriter,
            runId,
            {
              handoffNotes,
              variant: run.variant,
              diagnosisDetail: run.diagnosisDetail,
              activePlugins,
              complexity: run.classificationComplexity,
              specContent,
              baseBranch: config.branches.staging,
              reviewFindings: implementFindings,
            },
          );
          return implementResult;
        },
        escalate: async (event) => {
          console.warn(
            `[implement] Verifier gate refused for deployment ${event.deploymentId}, lane ${event.laneName}: ${event.reason}`,
          );
          run.lastFailure = createFailureRecord({
            kind: 'human-required',
            phase: 'implement',
            message: `Pre-implement verifier gate refused: lane '${event.laneName}' — ${event.reason}`,
            severity: 'blocking',
            retryable: false,
            repairAction: 'request-human',
            humanActionRequired: true,
            maxAttempts: 1,
          });
        },
      });

      if (guardResult.kind === 'refused') {
        return 'escalated';
      }

      const result = implementResult;
      if (result === undefined) {
        console.error(
          `[implement] Verifier gate proceeded but implement result is missing`,
        );
        return 'failure';
      }
      if (!result.ok) {
        console.error(`[implement] Error:`, result.error.message);
        return 'failure';
      }
      if (!result.value.success) {
        // Containment breach is terminal — signal pipeline to go stuck (STACK-AC-OPERATIONAL-SAFETY)
        if (result.value.containmentBreach) {
          console.error(
            `[implement] Containment breach detected:`,
            result.value.error,
          );
          return 'containment-breach';
        }
        // Persist handoff notes to RunState so they survive daemon crashes (STACK-AC-HANDOFF-COORDINATOR)
        if (result.value.handoffNotes) {
          run.handoffNotes = Object.fromEntries(result.value.handoffNotes);
        }
        console.error(`[implement] Failed:`, result.value.error);
        return 'failure';
      }
      // Clear stale handoff notes after successful completion (STACK-AC-HANDOFF-COORDINATOR: clear after success)
      run.handoffNotes = undefined;
      // Cost is synced from costTracker in pipeline.ts after every phase —
      // no manual run.cost += here (avoids double-counting).
      console.log(
        `[implement] Done, cost: $${result.value.totalCost.toFixed(2)}`,
      );

      // Batch processor removes the workspace worktree in its finally block.
      // If workspaceDir no longer exists, fall back to mainRepoRoot for the review phase.
      // coordinator.implement() checks out featureBranch in the main repo for merging — restore
      // to staging branch so the review phase sees current dev code and passing test suite.
      const { existsSync: workspaceDirExists } = await import('node:fs');
      const restoreResult = await git(
        ['checkout', config.branches.staging],
        mainRepoRoot,
      );
      if (restoreResult.ok) {
        console.log(
          `[implement] Restored main repo to ${config.branches.staging}`,
        );
      } else {
        console.warn(
          `[implement] Failed to restore branch to ${config.branches.staging}: ${restoreResult.error.message}`,
        );
      }
      if (!workspaceDirExists(workspaceDir)) {
        // Batch removes the worktree but the branch still has commits.
        // Recreate the worktree so review runs in the correct directory.
        console.log(
          `[implement] Workspace removed by batch — recreating worktree for review`,
        );
        const recreate = await git(
          ['worktree', 'add', workspaceDir, featureBranch],
          mainRepoRoot,
        );
        if (recreate.ok) {
          workspaceCwd = workspaceDir;
          run.workspacePath = workspaceDir;
          // Install dependencies so review gate commands (pnpm test, tsc) work
          const installResult = await runCommand(
            'pnpm',
            ['install', '--frozen-lockfile'],
            {
              cwd: workspaceDir,
              timeoutMs: 120_000,
            },
          );
          if (installResult.ok) {
            console.log(
              `[implement] Worktree recreated at ${workspaceDir} (deps installed)`,
            );
          } else {
            console.warn(
              `[implement] Worktree recreated but pnpm install failed — review gate may fail`,
            );
          }
        } else {
          console.warn(
            `[implement] Failed to recreate worktree: ${recreate.error.message} — falling back to repo root`,
          );
          workspaceCwd = mainRepoRoot;
        }
      }

      return 'success';
    },

    review: async (run: RunState): Promise<PhaseEvent> => {
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      console.log(`[review] Running review gates in ${cwd}`);

      // Use classifier-determined complexity (set in classify phase, line 83)
      const complexity: 'simple' | 'standard' | 'complex' =
        run.classificationComplexity ?? 'simple';

      // Determine risk sensitivity from work request metadata
      const riskSensitive = isRiskSensitive(
        workRequest.labels,
        workRequest.body + ' ' + (workRequest.scopeDescription ?? ''),
        [], // artifact paths — not tracked on WorkRequest yet
      );

      // Build diff for reviewer context.
      // Use explicit branch ref (not HEAD) so the diff is correct even when
      // a concurrent detect phase has checked out a different branch (#178).
      // Three-dot (merge-base) diff so the reviewer sees ONLY the branch's own
      // delta: with a two-dot diff, a staging branch that advanced after the
      // feature branch was cut shows phantom "reversions" of unrelated merges,
      // which the spec-compliance gate escalates on as false regressions (#847).
      // Truncate to 50 KB to avoid excessive prompt size that causes reviewer timeouts.
      const DIFF_MAX_BYTES = 50_000;
      let diff: string | undefined;
      try {
        const diffResult = await git(
          ['diff', config.branches.staging + '...' + featureBranch],
          workspaceCwd,
        );
        if (diffResult.ok) {
          diff =
            diffResult.value.length > DIFF_MAX_BYTES
              ? diffResult.value.slice(0, DIFF_MAX_BYTES) +
                '\n\n[diff truncated — showing first 50 KB of ' +
                diffResult.value.length +
                ' bytes]'
              : diffResult.value;
        }
      } catch {
        /* diff is optional context */
      }

      // Load actual spec content from .specify/ for reviewer (#122)
      const specifyRoot = join(cwd, '.specify');
      let specContent: string | undefined;
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[review] Failed to load spec content:`, e);
      }

      // Skip all gates if there's no diff (e.g., spec-only tasks with no code
      // changes). Running gate1 tests against the baseline codebase would fail on
      // pre-existing test failures unrelated to this branch — and spec tasks don't
      // modify code. This keeps the legacy (no-gateSets) path inert. NB for the
      // lane gate-set verdict (#19): an empty diff records NO passed gates, so a
      // deployment whose lane gate-set requires gates fails CLOSED at integrate
      // (escalates) — correct: a no-code change must not auto-merge under a gate
      // set, and we must not run gates against the baseline just to observe them.
      if (diff === undefined || diff.trim().length === 0) {
        console.log(`[review] No code changes — skipping all gates`);
        // Clear any gate observations from a PRIOR review cycle: no gates ran for
        // the current content, so none may be observed. Without this, a re-entry
        // (e.g. rework that left an empty diff) would carry stale passedGates and
        // the lane gate-set verdict could satisfy from gates that never ran for
        // this content — must fail CLOSED instead (codex).
        run.passedGates = undefined;
        return 'success';
      }

      // Create all four gates
      // Inject knowledge context (STACK-AC-VALIDATION: knowledge injection before reviewer spawn)
      let knowledgeContext: string | undefined;
      if (knowledgeStore) {
        try {
          const nameOnlyResult = await git(
            [
              'diff',
              '--name-only',
              // Merge-base scoped for the same reason as the reviewer diff (#847).
              config.branches.staging + '...' + featureBranch,
            ],
            workspaceCwd,
          );
          const artifactPaths = nameOnlyResult.ok
            ? nameOnlyResult.value.split('\n').filter(Boolean)
            : [];
          const ctx = await injectKnowledge(artifactPaths, knowledgeStore);
          if (ctx) knowledgeContext = ctx;
        } catch (e) {
          console.warn(`[review] Knowledge injection failed:`, e);
        }
      }

      const gate1 = createGate1(
        config.validation.gate1Commands,
        // Baseline mode (opt-in): re-run a failing command on the pristine base
        // checkout (mainRepoRoot, unmodified — worktrees branch off it) so
        // pre-existing failures don't stuck self-targeted runs. Off = strict.
        config.validation.baselinePreexistingFailures
          ? { baselineCwd: mainRepoRoot }
          : undefined,
      );
      const gate2 = createReviewerGate(
        'spec-compliance',
        'reviewer-spec',
        'Verify implementation against spec acceptance criteria.',
        runtime,
        workRequest.issueNumber,
        runWriter,
        runId,
        diff,
        specContent,
        activePlugins,
        knowledgeContext,
      );
      const gate3 = createReviewerGate(
        'quality',
        'reviewer-quality',
        'Evaluate code quality, pattern consistency, and test quality.',
        runtime,
        workRequest.issueNumber,
        runWriter,
        runId,
        diff,
        undefined,
        activePlugins,
        knowledgeContext,
      );
      const gate4 = createReviewerGate(
        'security',
        'reviewer-security',
        'Evaluate injection risks, authentication, data validation, and concurrency safety.',
        runtime,
        workRequest.issueNumber,
        runWriter,
        runId,
        diff,
        undefined,
        activePlugins,
        knowledgeContext,
      );

      // Select gates based on complexity and risk
      const gates = selectGates(
        complexity,
        riskSensitive,
        gate1,
        gate2,
        gate3,
        gate4,
      );
      console.log(
        `[review] Selected ${gates.length} gates (complexity=${complexity}, riskSensitive=${riskSensitive})`,
      );

      const result = await runReview(gates, cwd, {
        maxFixCycles: config.validation.maxFixCycles,
      });
      if (!result.passed) {
        // Human-readable "[gate] description" lines for every failing gate.
        // Shared by #1b (lastFailure message) and #4 (run.reviewFindings).
        const findingLines = result.gateResults
          .filter((g) => !g.passed)
          .flatMap((g) =>
            g.findings.length > 0
              ? g.findings.map((f) => `[${g.gate}] ${f.description}`)
              : [`[${g.gate}] gate failed (no findings reported)`],
          );

        // #4: stash the findings on the run so the next implement cycle can
        // consume them (re-implement is otherwise blind to what review flagged).
        run.reviewFindings = findingLines.length > 0 ? findingLines : undefined;

        // #1b: On escalation, record the REAL gate finding(s) on run.lastFailure
        // so the pipeline surfaces the actual blocking reason (e.g. the failed
        // gate-1 command) instead of "Unknown error". Falls back to a
        // descriptive message if no findings parsed.
        const recordEscalationFailure = (reason: string): void => {
          const findingSummary = findingLines.slice(0, 5).join('; ');
          const message = findingSummary
            ? `Review escalated (${reason}): ${findingSummary}`
            : `Review escalated (${reason}): review gates could not be satisfied`;
          run.lastFailure = createFailureRecord({
            kind: 'human-required',
            phase: 'review',
            message,
            severity: 'blocking',
            retryable: false,
            repairAction: 'request-human',
            humanActionRequired: true,
            maxAttempts: 1,
          });
        };

        if (result.escalated) {
          console.error(
            `[review] Escalated (${result.escalationReason ?? 'unknown'}):`,
            JSON.stringify(result.gateResults),
          );
          recordEscalationFailure(result.escalationReason ?? 'unknown');
          return 'escalated';
        }
        // Track review failures across implement→review loop iterations.
        // Without a fixHandler, runReview returns immediately — escalation must be
        // handled here using accumulated fixAttempts from prior cycles.
        const reviewFailures = run.fixAttempts.filter(
          (a) => a.phase === 'review',
        ).length;
        const errorHash =
          result.gateResults
            .find((g) => !g.passed)
            ?.findings[0]?.description?.slice(0, 64) ?? 'unknown';
        run.fixAttempts.push({
          phase: 'review',
          attempt: reviewFailures + 1,
          errorHash,
        });
        if (reviewFailures + 1 >= config.validation.maxFixCycles) {
          console.error(
            `[review] Max fix cycles (${config.validation.maxFixCycles}) reached, escalating:`,
            JSON.stringify(result.gateResults),
          );
          recordEscalationFailure('max-fix-cycles');
          return 'escalated';
        }
        console.error(
          `[review] Failed (attempt ${reviewFailures + 1}/${config.validation.maxFixCycles}):`,
          JSON.stringify(result.gateResults),
        );
        return 'failure';
      }
      console.log(`[review] Passed (${result.fixCycles} fix cycles)`);
      // Record the gate keys that RAN and PASSED so the lane-specific gate-set
      // verdict at integrate can observe them. Only passing gates are recorded —
      // a gate that did not pass must never appear, even on overall success.
      run.passedGates = result.gateResults
        .filter((g) => g.passed === true)
        .map((g) => g.gate);
      // Surface gate-1 baseline/degraded mode so a skipped pre-existing failure
      // is not silently dropped.
      if (result.gateResults.some((g) => g.baselineMode === true)) {
        run.gate1BaselineMode = true;
        console.warn(
          `[review] Gate-1 ran in baseline/degraded mode — one or more pre-existing failures were skipped; run marked tainted`,
        );
      }
      // #4: clear consumed findings once review passes so they don't bleed into
      // an unrelated later cycle.
      run.reviewFindings = undefined;
      return 'success';
    },

    holdout: async (run: RunState): Promise<PhaseEvent> => {
      if (!config.validation.holdoutCommand) {
        console.log(`[holdout] No holdout command configured — skipping`);
        return 'success';
      }
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      console.log(
        `[holdout] Running holdout tests for #${workRequest.issueNumber}`,
      );
      const result = await runHoldout(
        config.validation.holdoutCommand,
        featureBranch,
        cwd,
      );
      if (!result.ok) {
        console.error(`[holdout] Error:`, result.error.message);
        return 'failure';
      }
      if (!result.value.passed) {
        const failedIds = result.value.failures.map((f) => f.id).join(', ');
        console.error(`[holdout] Failed scenarios: ${failedIds}`);

        // Delegate to Bug Diagnosis Service for Type A/B/C classification
        // per ARCH-AC-CONTROL-PLANE spec (line 84): holdout failures must be classified
        // before routing — Type A → fix cycle, Type B → needs-spec-update, Type C → needs-human
        const threshold = config.diagnosis.confidenceThreshold;
        const specifyRoot = join(cwd, '.specify');
        let specContent = '';
        try {
          specContent = await loadSpecContent(
            workRequest.specRefs,
            specifyRoot,
          );
        } catch (e) {
          console.warn(`[holdout] Failed to load spec content:`, e);
        }
        let implementationContent = '';
        try {
          implementationContent = await loadImplementationContent(
            workRequest.specRefs,
            cwd,
          );
        } catch (e) {
          console.warn(`[holdout] Failed to load implementation content:`, e);
        }

        const bugReport = `Holdout test failures for issue #${workRequest.issueNumber}.\nFailed scenarios: ${failedIds}\n\nOriginal issue:\n${workRequest.body}`;
        const diagResult = await diagnose(
          runtime,
          workRequest.issueNumber,
          bugReport,
          implementationContent,
          specContent,
          runWriter,
          runId,
          workspaceCwd,
          activePlugins,
        );

        if (!diagResult.ok) {
          // Propagate safety signals before falling back to needs-human
          // (mirrors the diagnose phase handler — ARCH-AC-OPERATIONAL-SAFETY)
          if (diagResult.error instanceof SessionError) {
            if (diagResult.error.rateLimited) {
              console.warn(
                `[holdout] Diagnosis session rate-limited: ${diagResult.error.message} — signaling pipeline to pause`,
              );
              return 'rate-limited';
            }
            if (diagResult.error.containmentBreach) {
              console.warn(
                `[holdout] Diagnosis session containment breach: ${diagResult.error.message} — signaling pipeline`,
              );
              return 'containment-breach';
            }
            if (diagResult.error.message.startsWith('Budget exceeded')) {
              console.warn(
                `[holdout] Diagnosis session budget exceeded: ${diagResult.error.message} — signaling pipeline to pause`,
              );
              return 'budget-exceeded';
            }
          }
          console.error(
            `[holdout] Diagnosis failed:`,
            diagResult.error.message,
          );
          try {
            await octokit.issues.addLabels({
              owner,
              repo,
              issue_number: workRequest.issueNumber,
              labels: ['needs-human'],
            });
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number: workRequest.issueNumber,
              body: `## Holdout Diagnosis Failed\n\nHoldout scenarios failed (${failedIds}) but automatic diagnosis could not produce valid output.\nRouting to human for manual triage.`,
            });
          } catch (e) {
            console.error(`[holdout] Failed to update issue:`, e);
          }
          return 'escalated';
        }

        // Record diagnosis on run state for results ledger
        run.diagnosisType = diagResult.value.type;
        run.diagnosisConfidence = diagResult.value.confidence;
        run.diagnosisDetail = JSON.stringify(diagResult.value);

        const routing = routeDiagnosis(diagResult.value, threshold);
        if (routing.route === 'bug-pipeline') {
          // Type A: implementation defect — track fix attempt and route back to fix cycle.
          // Guard against infinite holdout→implement loop (mirrors review phase maxFixCycles logic).
          const holdoutFailures = run.fixAttempts.filter(
            (a) => a.phase === 'holdout',
          ).length;
          run.fixAttempts.push({
            phase: 'holdout',
            attempt: holdoutFailures + 1,
            errorHash: failedIds.slice(0, 64),
          });
          if (holdoutFailures + 1 >= config.validation.maxFixCycles) {
            console.error(
              `[holdout] Max fix cycles (${config.validation.maxFixCycles}) reached for Type A — escalating`,
            );
            return 'escalated';
          }
          console.log(
            `[holdout] Diagnosis Type A (confidence ${diagResult.value.confidence}) — routing to fix cycle (attempt ${holdoutFailures + 1}/${config.validation.maxFixCycles})`,
          );
          return 'failure';
        }

        // Type B or Type C / low confidence — post diagnosis and escalate to stuck
        const label =
          routing.route === 'needs-spec-update'
            ? 'needs-spec-update'
            : 'needs-human';
        const diagnosisComment = [
          `## Holdout Failure Diagnosis`,
          `**Type:** ${diagResult.value.type} | **Confidence:** ${diagResult.value.confidence}`,
          `**Failed Scenarios:** ${failedIds}`,
          `**Affected Specs:** ${diagResult.value.affectedSpecs.join(', ') || 'none'}`,
          `**Affected Artifacts:** ${diagResult.value.affectedArtifacts.join(', ') || 'none'}`,
          `**Suggested Action:** ${diagResult.value.suggestedAction}`,
          `**Reasoning:** ${diagResult.value.reasoning}`,
          '',
          routing.route === 'needs-spec-update'
            ? '_Routed to spec author — implementation is correct per spec, but spec is incomplete._'
            : `_Routed to human — ${routing.reason}_`,
        ].join('\n');
        console.log(`[holdout] Diagnosis ${routing.route} — labeling ${label}`);
        try {
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            labels: [label],
          });
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: workRequest.issueNumber,
            body: diagnosisComment,
          });
        } catch (e) {
          console.error(`[holdout] Failed to update issue:`, e);
        }
        return 'escalated';
      }
      console.log(`[holdout] All scenarios passed`);
      // Holdout is a lifecycle phase, not a review gate, so it appends its own
      // key to the observed passed-gates list without clobbering review keys.
      run.passedGates = [...(run.passedGates ?? []), 'holdout'];
      return 'success';
    },

    integrate: async (run: RunState): Promise<PhaseEvent> => {
      // P0.5 pause gate: an already-admitted run must not proceed through the
      // irreversible integrate merge while the daemon is paused. Park it at
      // integrate-entry; /resume re-admits via the existing integrate arm.
      if (isPaused?.() === true) {
        run.pausedAtPhase = 'integrate';
        return 'success';
      }

      const deploymentId = run.deploymentId;
      const registryInputs =
        registry !== undefined && deploymentId !== undefined
          ? registry.resolveLaneEngineInputs(deploymentId)
          : undefined;

      // Configured-but-unregistered: a deployment id is set AND a registry exists,
      // but the id resolves not-found — the profile was rejected at startup. The
      // operator OPTED INTO merge-decision policy for this deployment, so fail
      // CLOSED: hold the change for them rather than falling through to the legacy
      // unconditional merge.
      if (registryInputs !== undefined && registryInputs.kind === 'not-found') {
        console.error(
          `[integrate] deployment \"${deploymentId ?? '?'}\" is configured but not registered ` +
            `(its profile was rejected at startup) — holding the merge. Fix the deployment profile.`,
        );
        return 'failure';
      }

      // A configured deployment must OWN this run's repo.
      if (
        registry !== undefined &&
        deploymentId !== undefined &&
        registryInputs !== undefined &&
        registryInputs.kind === 'found' &&
        registry.ownsRepo(deploymentId, owner, repoName) === false
      ) {
        console.error(
          `[integrate] deployment "${deploymentId}" does not own ${owner}/${repoName} — ` +
            `refusing to apply its profile (failing closed).`,
        );
        return 'failure';
      }

      // Flag-OFF: NO deployment configured → legacy ungoverned direct merge.
      if (registryInputs === undefined || deploymentId === undefined) {
        console.log(
          `[integrate] ungoverned delivery — no deployment profile; using config.branches.staging`,
        );
        const result = await integrateToStaging(
          featureBranch,
          config.branches.staging,
          mainRepoRoot,
        );
        if (!result.ok) {
          console.error(`[integrate] Error:`, result.error.message);
          return 'failure';
        }
        if (!result.value.success) {
          console.error(`[integrate] Failed:`, result.value.error);
          return 'failure';
        }
        if (result.value.pushed === true) {
          console.log(
            `[integrate] Successfully merged ${featureBranch} → ${config.branches.staging} and pushed to origin`,
          );
        } else if (
          result.value.pushError !== undefined &&
          result.value.pushError !== ''
        ) {
          console.warn(
            `[integrate] Merged locally but push failed (non-fatal): ${result.value.pushError}`,
          );
        } else {
          console.log(
            `[integrate] Successfully merged to ${config.branches.staging}`,
          );
        }
        return 'success';
      }

      // Flag-ON: resolve the deployment's declared landing target.
      const landingResolution = resolveLandingTarget({
        registry,
        deploymentId,
        fallbackStaging: config.branches.staging,
      });
      if (landingResolution.kind === 'escalate') {
        console.error(`[integrate] ${landingResolution.reason}`);
        return 'failure';
      }
      const landsOn = landingResolution.landsOn;
      const landing = readLandingTarget(deploymentId);
      const requiredChecks = landing?.requiredChecks ?? [];

      // Governed deployments must declare which checks are required. Empty list
      // is fail-closed (escalate), never a silent green.
      if (requiredChecks.length === 0) {
        console.error(
          `[integrate] governed deployment "${deploymentId}" has no landing.requiredChecks — ` +
            `cannot perform a controlled merge (failing closed).`,
        );
        return 'failure';
      }

      const observeTrunkForRevert = async ({
        mergeSha,
      }: {
        repoRoot: string;
        trunkBranch: string;
        mergeSha: string;
      }): Promise<TrunkObservation> => {
        const result = await awaitRequiredChecks({
          octokit,
          owner,
          repo: repoName,
          ref: mergeSha,
          requiredChecks,
          budgetMs: 60_000,
          pollMs: 5_000,
        });
        if (result.status === 'green') {
          return { status: 'healthy', summary: 'trunk checks green after landing' };
        }
        if (result.status === 'red') {
          return {
            status: 'red',
            summary: result.reason ?? 'trunk checks red after landing',
          };
        }
        return {
          status: 'indeterminate',
          summary:
            result.reason ??
            'trunk checks did not resolve (timeout or no required checks)',
        };
      };

      const integrateArtifact = getOrCreateIntegrateArtifact(run, landsOn);

      // Operator-approved reversal: merge the revert PR, not the original.
      if (
        run.mergeDecisionApprovedEpoch === run.mergeDecisionEpoch &&
        integrateArtifact.status === 'reversal-raised' &&
        integrateArtifact.reversal !== undefined
      ) {
        try {
          const mergeResult = await octokit.pulls.merge({
            owner,
            repo: repoName,
            pull_number: integrateArtifact.reversal.revertPullRequestNumber,
            merge_method: 'squash',
          });
          integrateArtifact.status = 'reverted';
          integrateArtifact.mergeIdentifier = mergeResult.data.sha;
          integrateArtifact.updatedAt = new Date().toISOString();
          run.mergeDecisionApprovedEpoch = undefined;
          console.log(
            `[integrate] Revert PR #${integrateArtifact.reversal.revertPullRequestNumber} merged for #${workRequest.issueNumber}`,
          );
          return 'success';
        } catch (error: unknown) {
          console.error(
            `[integrate] Failed to merge revert PR for #${workRequest.issueNumber}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 'failure';
        }
      }

      // A prior automated revert failed and was escalated. Do not re-enter
      // delivery; the degraded decision is already raised (idempotent).
      if (
        integrateArtifact.status === 'observed-red' &&
        integrateArtifact.mergeSha !== undefined
      ) {
        console.error(
          `[integrate] Prior post-landing observation failed for #${workRequest.issueNumber} ` +
            `and was escalated — failing closed rather than re-delivering.`,
        );
        return 'failure';
      }

      // Resume from an already-landed delivery (crash after API merge but before
      // observation). Skip re-delivery and observe the persisted merge SHA.
      if (
        integrateArtifact.status === 'joined' &&
        integrateArtifact.mergeSha !== undefined
      ) {
        return await runPostLandingObservation(
          integrateArtifact.mergeSha,
          integrateArtifact.pullRequestNumber,
        );
      }

      async function runPostLandingObservation(
        mergeSha: string,
        prNumber: number | undefined,
      ): Promise<PhaseEvent> {
        try {
          const observationResult = await handlePostLandingObservation({
            repoRoot: mainRepoRoot,
            owner,
            repo: repoName,
            deployment: deploymentId ?? 'unknown',
            run,
            trunkBranch: landsOn,
            mergeSha,
            featureHeadSha: featureBranch,
            revertBranch: `revert/${workRequest.issueNumber}/${prNumber ?? 'x'}`,
            observeTrunk: observeTrunkForRevert,
            octokit,
            raiseDecisionRequest: async (request) => {
              if (decisionManager?.isAvailable() !== true) {
                throw new Error(
                  'decision index unavailable — cannot raise reversal decision',
                );
              }
              const ledger = decisionManager.ledger();
              const sanitized = await sanitizeDecisionRequest(
                request as DecisionRequest,
              );
              await withGovernedDecisionMarking(decisionManager, deploymentId, () =>
                ledger.raise(sanitized),
              );
            },
            now: new Date().toISOString(),
          });

          if (observationResult.action === 'reversal-raised') {
            integrateArtifact.status = 'reversal-raised';
            integrateArtifact.observation = {
              ...observationResult.observation,
              observedAt: new Date().toISOString(),
            };
            integrateArtifact.reversal = {
              revertBranch: `revert/${workRequest.issueNumber}/${prNumber ?? 'x'}`,
              revertPullRequestNumber: observationResult.prNumber,
              revertPullRequestUrl: observationResult.prUrl,
              decisionId: observationResult.decisionId,
            };
            integrateArtifact.updatedAt = new Date().toISOString();
            run.pausedAtPhase = 'integrate';
            return 'success';
          }

          integrateArtifact.status = 'observed-healthy';
          integrateArtifact.observation = {
            ...observationResult.observation,
            observedAt: new Date().toISOString(),
          };
          integrateArtifact.updatedAt = new Date().toISOString();
          return 'success';
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[integrate] Post-landing observation failed for #${workRequest.issueNumber}: ${errorMessage}`,
          );

          try {
            if (decisionManager?.isAvailable() === true) {
              const degraded = buildDegradedReversalEscalationRequest({
                run,
                deployment: deploymentId ?? 'unknown',
                mergeSha,
                error: errorMessage,
                now: new Date().toISOString(),
              });
              const sanitized = await sanitizeDecisionRequest(degraded);
              await withGovernedDecisionMarking(decisionManager, deploymentId, () =>
                decisionManager.ledger().raise(sanitized),
              );
              console.error(
                `[integrate] Raised degraded escalation for red trunk + failed auto-revert on #${workRequest.issueNumber}`,
              );
            } else {
              markRuntimeDegradedIfGoverned(
                decisionManager,
                deploymentId,
                `decision index unavailable for degraded reversal escalation on ${deploymentId ?? '?'}`,
              );
            }
          } catch (escalationError: unknown) {
            console.error(
              `[integrate] Failed to raise degraded reversal escalation: ${escalationError instanceof Error ? escalationError.message : String(escalationError)}`,
            );
          }

          integrateArtifact.status = 'observed-red';
          integrateArtifact.observation = {
            status: 'red',
            summary: `Post-landing observation or automated revert failed: ${errorMessage}`,
            observedAt: new Date().toISOString(),
          };
          integrateArtifact.updatedAt = new Date().toISOString();
          return 'failure';
        }
      }

      // Flag-ON: gather live inputs and ask the pure decision core.
      const { laneSet, riskPathMap, defaultMinLevel, mode } = registryInputs.inputs;
      const verdict: ClassifierVerdict | null =
        run.classificationComplexity !== undefined
          ? {
              complexity: run.classificationComplexity,
              changeKind: run.classifierChangeKind,
              scope: run.classifierScope,
            }
          : null;
      const classifierLevel = classifierLevelFromComplexity(run.classificationComplexity);

      let touchedPaths: string[];
      try {
        touchedPaths = await computeTouchedPaths(
          featureBranch,
          landsOn,
          mainRepoRoot,
        );
      } catch (e) {
        console.warn(
          `[integrate] Failed to compute touched paths (failing closed): ${e instanceof Error ? e.message : String(e)}`,
        );
        return 'failure';
      }

      // Resolve the assigned lane so we can observe its declared verifier.
      const resolvedSet = resolveForMode(laneSet, mode);
      const assignment = assignLane(resolvedSet, verdict);
      const assignedLane =
        resolvedSet.lanes.find((l) => l.name === assignment.lane) ??
        resolvedSet.lanes.find((l) => l.name === resolvedSet.mostCautiousLane);
      const verifierStatus = observeVerifierStatus(assignedLane?.verifier, {
        probeOracle: createProbeOracle(mainRepoRoot),
      });

      // Human-gated autonomy: default-deny unless the registry records widening.
      const autonomyWidened = (level: RiskLevel, lane: string): boolean => {
        if (deploymentId === undefined) return false;
        const readings = registry?.readAutonomyState(deploymentId, level, lane) ?? [];
        return readings.some((r) => r.level === 'widened');
      };

      // Lane-specific gate-set verdict (XCUT P2#1).
      let validationPassed = true;
      if (registry !== undefined && deploymentId !== undefined) {
        const gateSetsDeclared = registry.readDeclaredData(
          deploymentId,
          'gateSets',
        );
        if (
          gateSetsDeclared.kind === 'found' &&
          gateSetsDeclared.value !== undefined
        ) {
          const gateSets = gateSetsDeclared.value as GateSetDefinitions;
          const laneGateSet = assignedLane?.gateSet;
          const definition =
            laneGateSet !== undefined ? gateSets[laneGateSet] : undefined;
          validationPassed =
            definition !== undefined
              ? gateSetVerdict(definition.required, run.passedGates ?? [])
              : false;
        }
      }

      // Compliance lens.
      let complianceForced = false;
      if (registry !== undefined && deploymentId !== undefined) {
        const declared = registry.readDeclaredData(deploymentId, 'complianceReviewers');
        if (declared.kind === 'found' && Array.isArray(declared.value)) {
          complianceForced = evaluateComplianceForced(
            declared.value as ComplianceReviewer[],
            touchedPaths,
          );
        }
      }

      const decision = decideMerge({
        laneSet,
        riskPathMap,
        defaultMinLevel,
        mode,
        verdict,
        classifierLevel,
        touchedPaths,
        verifierStatus,
        validationPassed,
        autonomyWidened,
        complianceForced,
      });
      run.mergeDecision = decision;

      const isApprovedReEntry =
        run.mergeDecisionEpoch !== undefined &&
        run.mergeDecisionApprovedEpoch === run.mergeDecisionEpoch;
      const shouldMerge =
        decision.kind === 'auto-merge' || isApprovedReEntry;

      if (shouldMerge) {
        run.pausedAtPhase = undefined;
      }

      // Open/adopt the PR. For hold/escalate decisions we create the parked
      // artifact but never merge here.
      const deliveryResult = await deliverCodeChangeViaPR({
        octokit,
        owner,
        repo: repoName,
        featureBranch,
        landsOn,
        requiredChecks,
        phaseArtifact: integrateArtifact,
        awaitRequiredChecks: (args) =>
          awaitRequiredChecks({ octokit, ...args }),
        pushFeatureBranch,
        trigger: isApprovedReEntry
          ? { kind: 'operator-approved-epoch', detail: 'mergeDecisionApprovedEpoch re-entry' }
          : { kind: 'auto-merge', detail: 'merge decision returned auto-merge' },
        skipMerge: !shouldMerge,
      });

      if (deliveryResult.merged && deliveryResult.mergeSha !== undefined) {
        // After a successful operator-approved merge, clear the one-shot override.
        if (run.mergeDecisionApprovedEpoch === run.mergeDecisionEpoch) {
          run.mergeDecisionApprovedEpoch = undefined;
        }

        // P4.1 escalation metric: append an auto-merge event ONLY for true
        // auto-merge outcomes.
        if (decision.kind === 'auto-merge' && deploymentId !== undefined) {
          void appendAutoMergeEvent(stateDir, {
            ts: new Date().toISOString(),
            deploymentId,
            issueNumber: workRequest.issueNumber,
          });
        }

        // Post-landing observation on the squash merge SHA.
        return await runPostLandingObservation(
          deliveryResult.mergeSha,
          deliveryResult.prNumber,
        );
      }

      // PR was created/adopted but NOT merged (checks red/timeout, hold/escalate,
      // or delivery error). Park and raise a DecisionRequest if possible.
      if (decisionManager?.isAvailable() !== true) {
        markRuntimeDegradedIfGoverned(
          decisionManager,
          deploymentId,
          `decision index unavailable for governed deployment ${deploymentId ?? '?'}`,
        );
        console.error(
          `[integrate] Merge decision for #${workRequest.issueNumber} is ${decision.kind} but the ` +
            `decision index is unavailable (disabled or unreachable) — cannot surface it for approval; ` +
            `holding (failing closed).`,
        );
        return 'failure';
      }

      console.log(
        `[integrate] Merge decision for #${workRequest.issueNumber}: ${decision.kind} (${'reason' in decision ? decision.reason : 'awaiting-independent-review'}) — parking`,
      );
      const wasAlreadyParked = run.pausedAtPhase === 'integrate';
      run.pausedAtPhase = 'integrate';

      if (!wasAlreadyParked) {
        run.mergeDecisionEpoch = (run.mergeDecisionEpoch ?? 0) + 1;
        run.mergeDecisionBlockPublished = false;
      }

      if (
        decisionManager?.isAvailable() === true &&
        run.mergeDecisionEpoch !== undefined &&
        run.mergeDecisionBlockPublished !== true
      ) {
        try {
          const ledger = decisionManager.ledger();
          const request = buildMergeDecisionRequest(
            run,
            run.mergeDecisionEpoch,
            deploymentId,
            decision,
          );
          const sanitized = await sanitizeDecisionRequest(request);
          const { decision_id } = await withGovernedDecisionMarking(
            decisionManager,
            deploymentId,
            () => ledger.raise(sanitized),
          );
          const published = await resolveDecisionPublisher().ensure({
            request: sanitized,
            octokit,
            owner,
            repo: repoName,
            issueNumber: workRequest.issueNumber,
          });
          if (published.posted) {
            await alertOnNotifyApplied(
              () =>
                withGovernedDecisionMarking(decisionManager, deploymentId, () =>
                  ledger.notify(decision_id),
                ),
              alert,
              {
                issueNumber: workRequest.issueNumber,
                decisionId: decision_id,
                title: sanitized.question,
                dashboardBaseUrl: config.dashboardBaseUrl,
              },
            );
            run.mergeDecisionBlockPublished = true;
            clearRuntimeDegradedIfGoverned(decisionManager, deploymentId);
          } else {
            console.warn(
              `[integrate] decision block not published for #${workRequest.issueNumber} (${published.reason ?? 'unknown'}) — staying parked, will retry`,
            );
          }
        } catch (e) {
          console.warn(
            `[integrate] decision-index raise/publish/notify failed (failing closed, run stays parked): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return 'success';
    },

    deploy: async (run: RunState): Promise<PhaseEvent> => {
      if (
        !config.validation.deployCommand ||
        !config.validation.healthCheckUrl
      ) {
        console.log(
          `[deploy] No deploy command or health check URL configured — skipping`,
        );
        return 'success';
      }
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      console.log(`[deploy] Running deploy for #${workRequest.issueNumber}`);
      const result = await runDeploy({
        deployCommand: config.validation.deployCommand,
        healthCheckUrl: config.validation.healthCheckUrl,
        healthCheckIntervalMs: config.validation.healthCheckIntervalMs,
        deployTimeoutMs: config.validation.deployTimeoutMs,
        maxAttempts: config.validation.maxDeployAttempts,
        cwd,
      });
      if (!result.ok) {
        console.error(`[deploy] Error:`, result.error.message);
        return 'failure';
      }
      if (result.value.status !== 'healthy') {
        console.error(
          `[deploy] Deploy status: ${result.value.status} after ${result.value.attempts} attempt(s)`,
        );
        return 'failure';
      }
      console.log(`[deploy] Healthy after ${result.value.attempts} attempt(s)`);
      return 'success';
    },

    test: async (run: RunState): Promise<PhaseEvent> => {
      if (config.validation.testCommands.length === 0) {
        console.log(
          `[test] No post-deploy test commands configured — skipping`,
        );
        return 'success';
      }
      await ensureWorkspace(run);
      const cwd = workspaceCwd;
      console.log(
        `[test] Running post-deploy tests for #${workRequest.issueNumber}`,
      );
      const result = await runPostDeployTests({
        testCommands: config.validation.testCommands,
        maxFixAttempts: config.validation.maxTestFixAttempts,
        failureExcerptLines: config.validation.failureExcerptLines,
        cwd,
      });
      if (result.escalated) {
        console.error(
          `[test] Escalated after ${result.fixAttempts} fix attempt(s): ${result.failedCommand}`,
        );
        run.fixAttempts.push({
          phase: 'test',
          attempt: result.fixAttempts,
          errorHash: result.failureExcerpt ?? '',
        });
        return 'failure';
      }
      if (!result.passed) {
        console.error(`[test] Failed: ${result.failedCommand}`);
        run.fixAttempts.push({
          phase: 'test',
          attempt: result.fixAttempts,
          errorHash: result.failureExcerpt ?? '',
        });
        return 'failure';
      }
      console.log(`[test] All post-deploy tests passed`);
      return 'success';
    },

    report: async (run: RunState): Promise<PhaseEvent> => {
      const outcome = 'complete';
      let reportBody: string;
      try {
        reportBody = formatReport(run, outcome);
      } catch (err) {
        console.error(`[report] formatReport failed (non-fatal):`, err);
        reportBody = `Issue #${workRequest.issueNumber} completed (report generation failed)`;
      }
      run.report = reportBody;
      phaseLabelMirror?.clearPhaseLabels(workRequest.issueNumber, run);

      // Report phase is best-effort: the implementation work is already done.
      // If any GitHub/notification call fails, log the error but still return
      // 'success' so the pipeline completes rather than going stuck.
      try {
        // Post report as comment
        await postReport(
          octokit,
          owner,
          repo,
          workRequest.issueNumber,
          reportBody,
        );
      } catch (err) {
        console.error(`[report] postReport failed (non-fatal):`, err);
      }

      try {
        // Complete the work request (label + close)
        const completeResult = await detector.completeWork(
          workRequest.issueNumber,
          reportBody,
        );
        if (!completeResult.ok) {
          console.error(
            `[report] completeWork failed (non-fatal):`,
            completeResult.error,
          );
        }
      } catch (err) {
        console.error(`[report] completeWork failed (non-fatal):`, err);
      }

      try {
        // Append to results ledger
        await appendResult(
          {
            issueNumber: workRequest.issueNumber,
            startedAt: run.startedAt,
            completedAt: new Date().toISOString(),
            variant: run.variant,
            totalCost: run.cost,
            phasesExecuted: Object.keys(run.phaseCompletions),
            fixAttemptCount: run.fixAttempts.length,
            outcome,
            diagnosisType: run.diagnosisType,
            diagnosisConfidence: run.diagnosisConfidence,
          },
          stateDir,
        );
      } catch (err) {
        console.error(`[report] appendResult failed (non-fatal):`, err);
      }

      try {
        // Notify
        await notify(config.webhooks, {
          event: 'complete',
          issueNumber: workRequest.issueNumber,
          message: `Issue #${workRequest.issueNumber} completed ($${run.cost.toFixed(2)})`,
        });
      } catch (err) {
        console.error(`[report] notify failed (non-fatal):`, err);
      }

      return 'success';
    },
  };
}
