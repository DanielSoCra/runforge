// src/control-plane/phases.ts
import type { PhaseHandlerMap } from './pipeline.js';
import type { RunState, PhaseEvent, WorkRequest } from '../types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import type { Config } from '../config.js';
import { createGate1, selectGates, type Gate } from '../validation/gates.js';
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
import { join } from 'node:path';
import { diagnose } from '../diagnosis/diagnostician.js';
import { routeDiagnosis } from '../diagnosis/router.js';
import { loadSpecContent, loadImplementationContent, resolveCurrentSpecRefs } from '../infra/spec-loader.js';
import { classify as runClassify } from './classifier.js';
import { SessionError } from '../session-runtime/session-error.js';
import { runHoldout } from '../validation/holdout.js';
import { integrateToStaging } from './integration.js';
import { runDeploy } from '../validation/deploy.js';
import { runPostDeployTests } from '../validation/post-deploy-test.js';
import { reconcileWorkspace } from './workspace.js';
import { extractStructuredOutput } from '../lib/structured-output.js';
import { complianceReportJsonSchema } from '../diagnosis/schema.js';

// Serializes git operations on the shared repoRoot across concurrent pipeline runs.
// Currently protects detect (which modifies checkout state via git checkout).
// Review uses explicit branch refs (#178) so it no longer depends on checkout state.
// Single-process cooperative async — boolean suffices (same as integrationLock).
let repoGitLock = false;

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

export function createPhaseHandlers(
  config: Config,
  owner: string,
  repoName: string,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  octokit: Octokit,
  workRequest: WorkRequest,
  stateDir: string,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  repoRoot?: string,
  activePlugins?: Array<{ id: string; activatedAt: string }>,
  knowledgeStore?: KnowledgeStore,
): PhaseHandlerMap {
  const repo = repoName;
  const detector = createWorkDetector(octokit, owner, repo);
  const featureBranch = `feature/${workRequest.issueNumber}`;
  // Workspace isolation: sessions run in a worktree, not the daemon's own directory.
  // This prevents `git checkout` from swapping the daemon's source code out from under it.
  const mainRepoRoot = repoRoot ?? process.cwd();
  const workspaceDir = join(mainRepoRoot, 'workspaces', `issue-${workRequest.issueNumber}`);
  // After detect, all phases use workspaceCwd instead of repoRoot.
  // Restored from run.workspacePath on resume (survives daemon restarts).
  let workspaceCwd: string = mainRepoRoot;
  let workspaceRestored = false;

  /** Restore workspaceCwd from persisted run state if not already set. */
  const ensureWorkspace = async (run: RunState) => {
    if (workspaceRestored || workspaceCwd !== mainRepoRoot) return;
    if (run.workspacePath) {
      const { existsSync } = await import('node:fs');
      if (existsSync(run.workspacePath)) {
        workspaceCwd = run.workspacePath;
        console.log(`[phases] Restored workspace from run state: ${workspaceCwd}`);
      } else {
        console.warn(`[phases] Persisted workspace ${run.workspacePath} gone — using repo root`);
      }
    }
    workspaceRestored = true;
  };

  return {
    detect: async (run: RunState): Promise<PhaseEvent> => {
      if (!acquireRepoGitLock()) {
        console.error(`[detect] Lock held by another run — aborting`);
        return 'failure';
      }
      try {
        console.log(`[detect] Reconciling workspace ${workspaceDir} for ${featureBranch} from ${config.branches.staging}`);
        const reconciled = await reconcileWorkspace({
          repoRoot: mainRepoRoot,
          workspaceDir,
          featureBranch,
          stagingBranch: config.branches.staging,
        });
        if (!reconciled.ok) {
          console.error(`[detect] Workspace reconcile failed:`, reconciled.error.message);
          return 'failure';
        }
        workspaceCwd = reconciled.value.path;
        run.workspacePath = reconciled.value.path; // Persist for daemon restart recovery
        return 'success';
      } finally {
        releaseRepoGitLock();
      }
    },

    // --- Spec-driven pipeline phase handlers ---

    'l2-design': async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[l2-design] Generating L2 architecture spec for #${workRequest.issueNumber}`);
      await ensureWorkspace(run); const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      let specContent = '';
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[l2-design] Failed to load spec content:`, e);
      }
      const result = await runtime.spawnSession('l2-designer', {
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
      }, workRequest.issueNumber, undefined, runWriter, runId);
      run.l2Feedback = undefined;
      if (!result.ok) {
        console.error(`[l2-design] Session failed: ${result.error.message}`);
        return 'failure';
      }
      if (result.value.exitStatus === 'timed-out' || result.value.exitStatus === 'failed') {
        console.error(`[l2-design] Session exited with status: ${result.value.exitStatus}`);
        return 'failure';
      }
      // Refresh spec refs after L2 design session generates new specs
      try {
        run.specRefs = await resolveCurrentSpecRefs(cwd, workRequest.specRefs);
      } catch (e) {
        console.warn(`[l2-design] Failed to refresh spec refs:`, e);
      }
      return 'success';
    },

    'l2-gate': async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[l2-gate] Checking L2 gate labels for #${workRequest.issueNumber}`);
      // Fetch current issue labels
      let labels: string[];
      try {
        const response = await octokit.issues.get({
          owner, repo, issue_number: workRequest.issueNumber,
        });
        labels = (response.data.labels as Array<{ name?: string } | string>).map(
          (l) => (typeof l === 'string' ? l : l.name ?? ''),
        );
      } catch (e) {
        console.error(`[l2-gate] Failed to fetch issue labels:`, e);
        return 'failure';
      }

      if (labels.includes('l2-approved')) {
        console.log(`[l2-gate] L2 approved for #${workRequest.issueNumber}`);
        return 'success';
      }
      if (labels.includes('l2-rejected')) {
        console.log(`[l2-gate] L2 rejected for #${workRequest.issueNumber} — looping back to l2-design`);
        // Fetch the most recent rejection comment to pass as feedback to the designer
        try {
          const comments = await octokit.issues.listComments({
            owner, repo, issue_number: workRequest.issueNumber, per_page: 20,
          });
          const rejectionComment = [...comments.data].reverse().find(
            (c) => c.body?.includes('REJECTED') || c.body?.includes('l2-rejected'),
          );
          if (rejectionComment?.body) {
            // Sanitize before storing: strip {{placeholder}} patterns (defense against
            // template injection via renderTemplate) and cap length to limit prompt size.
            const MAX_FEEDBACK_LENGTH = 4000;
            run.l2Feedback = rejectionComment.body
              .replace(/\{\{[\w-]+\}\}/g, '')
              .slice(0, MAX_FEEDBACK_LENGTH);
            console.log(`[l2-gate] Captured rejection feedback for #${workRequest.issueNumber}`);
          }
        } catch (e) {
          console.warn(`[l2-gate] Failed to fetch rejection comment:`, e);
        }
        // Remove l2-rejected label so next gate check doesn't re-trigger immediately
        try {
          await octokit.issues.removeLabel({
            owner, repo, issue_number: workRequest.issueNumber, name: 'l2-rejected',
          });
        } catch (e) {
          console.warn(`[l2-gate] Failed to remove l2-rejected label:`, e);
        }
        run.l2GateNotified = false;
        return 'feedback';
      }
      // Neither approved nor rejected — park the run
      console.log(`[l2-gate] No L2 decision yet for #${workRequest.issueNumber} — parking`);
      run.pausedAtPhase = 'l2-gate';
      // First park: add label and post comment
      if (!run.l2GateNotified) {
        try {
          await octokit.issues.addLabels({
            owner, repo, issue_number: workRequest.issueNumber,
            labels: ['awaiting-l2-review'],
          });
          await octokit.issues.createComment({
            owner, repo, issue_number: workRequest.issueNumber,
            body: `## Awaiting L2 Review\n\nThe L2 architecture spec is ready for review. Add the \`l2-approved\` label to continue, or \`l2-rejected\` to send back for revision.`,
          });
        } catch (e) {
          console.error(`[l2-gate] Failed to notify:`, e);
        }
        run.l2GateNotified = true;
      }
      return 'success';
    },

    'l3-generate': async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[l3-generate] Generating L3 stack spec for #${workRequest.issueNumber}`);
      await ensureWorkspace(run); const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      // Refresh spec refs before generation to pick up L2 specs
      try {
        run.specRefs = await resolveCurrentSpecRefs(cwd, workRequest.specRefs);
      } catch (e) {
        console.warn(`[l3-generate] Failed to refresh spec refs before generation:`, e);
      }
      let specContent = '';
      try {
        specContent = await loadSpecContent(run.specRefs ?? workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[l3-generate] Failed to load spec content:`, e);
      }
      const result = await runtime.spawnSession('l3-generator', {
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
      }, workRequest.issueNumber, undefined, runWriter, runId);
      if (!result.ok) {
        console.error(`[l3-generate] Session failed: ${result.error.message}`);
        // Retain l3Feedback so the retry attempt sees the same compliance findings
        // (Codex review 636ca05 — clearing before failure check loses feedback on
        //  transient l3-generate self-loop retries).
        return 'failure';
      }
      if (result.value.exitStatus === 'timed-out' || result.value.exitStatus === 'failed') {
        console.error(`[l3-generate] Session exited with status: ${result.value.exitStatus}`);
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
        console.warn(`[l3-generate] Failed to refresh spec refs after generation:`, e);
      }
      return 'success';
    },

    'l3-compliance': async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[l3-compliance] Reviewing L3 compliance for #${workRequest.issueNumber}`);
      await ensureWorkspace(run); const cwd = workspaceCwd;
      const specifyRoot = join(cwd, '.specify');
      let specContent = '';
      try {
        specContent = await loadSpecContent(run.specRefs ?? workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[l3-compliance] Failed to load spec content:`, e);
      }

      const result = await runtime.spawnSession('compliance-reviewer', {
        variables: {
          issueNumber: String(workRequest.issueNumber),
          issueTitle: workRequest.title,
          issueBody: workRequest.body,
          specContent,
          owner,
          repo: repoName,
        },
        workspacePath: cwd,
      }, workRequest.issueNumber, { jsonSchema: complianceReportJsonSchema }, runWriter, runId);

      // Helper: every failure path must increment the counter and check the cap.
      const recordFailureAndMaybeEscalate = (feedback?: string): PhaseEvent => {
        if (feedback !== undefined) {
          const MAX_FEEDBACK_LENGTH = 4000;
          run.l3Feedback = feedback.replace(/\{\{[\w-]+\}\}/g, '').slice(0, MAX_FEEDBACK_LENGTH);
        }
        run.l3ComplianceAttempts = (run.l3ComplianceAttempts ?? 0) + 1;
        const MAX_L3_COMPLIANCE_ATTEMPTS = 3;
        if (run.l3ComplianceAttempts >= MAX_L3_COMPLIANCE_ATTEMPTS) {
          console.error(`[l3-compliance] Exhausted ${MAX_L3_COMPLIANCE_ATTEMPTS} attempts — escalating to stuck`);
          return 'escalated';
        }
        return 'failure';
      };

      if (!result.ok) {
        console.error(`[l3-compliance] Session failed: ${result.error.message}`);
        return recordFailureAndMaybeEscalate(`Compliance session error: ${result.error.message}`);
      }
      if (result.value.exitStatus === 'timed-out' || result.value.exitStatus === 'failed') {
        console.error(`[l3-compliance] Session exited with status: ${result.value.exitStatus}`);
        return recordFailureAndMaybeEscalate(`Compliance session ended with exit status: ${result.value.exitStatus}`);
      }

      const payload = extractStructuredOutput(result.value?.structuredData) as
        | {
            compliant?: boolean;
            findings?: Array<{ type?: string; severity?: string; location?: string; description?: string }>;
            summary?: string;
          }
        | undefined;

      if (payload?.compliant === false) {
        const findingLines = (payload.findings ?? []).map(
          (f) => `- [${f.severity ?? 'unknown'}] ${f.location ?? ''}: ${f.description ?? ''}`,
        ).join('\n');
        const feedback = `Compliance findings:\n${findingLines}\n\n${payload.summary ?? ''}`;
        console.log(`[l3-compliance] Compliance failed — captured ${payload.findings?.length ?? 0} findings`);
        return recordFailureAndMaybeEscalate(feedback);
      }

      // Success path — clear counter and any stale feedback so the next round starts fresh.
      run.l3ComplianceAttempts = undefined;
      run.l3Feedback = undefined;
      return 'success';
    },

    decompose: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(`[decompose] Decompose phase for #${workRequest.issueNumber} — pass-through`);
      return 'success';
    },

    // --- Standard pipeline phase handlers ---

    classify: async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[classify] Classifying work request #${workRequest.issueNumber}`);
      const result = await runClassify(runtime, workRequest, runWriter, runId, workspaceCwd, activePlugins);
      run.classificationComplexity = result.complexity;
      return result.event;
    },

    diagnose: async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[diagnose] Running diagnosis for #${workRequest.issueNumber}`);
      const threshold = config.diagnosis.confidenceThreshold;

      // Load actual spec content from .specify/ (not just spec IDs) (#143)
      await ensureWorkspace(run); const cwd = workspaceCwd;
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
        implementationContent = await loadImplementationContent(workRequest.specRefs, cwd);
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
            console.warn(`[diagnose] Diagnosis session rate-limited: ${result.error.message} — signaling pipeline to pause`);
            return 'rate-limited';
          }
          if (result.error.containmentBreach) {
            console.warn(`[diagnose] Diagnosis session containment breach: ${result.error.message} — signaling pipeline`);
            return 'containment-breach';
          }
          // SessionError.budgetExceeded() has cost=0, rateLimited=false, containmentBreach=false —
          // no dedicated boolean, so detect via message prefix (matches factory method format)
          if (result.error.message.startsWith('Budget exceeded')) {
            console.warn(`[diagnose] Diagnosis session budget exceeded: ${result.error.message} — signaling pipeline to pause`);
            return 'budget-exceeded';
          }
        }
        console.error(`[diagnose] Diagnosis failed:`, result.error.message);
        // Diagnosis failed — route to human
        try {
          await octokit.issues.addLabels({
            owner, repo, issue_number: workRequest.issueNumber,
            labels: ['needs-human'],
          });
          await octokit.issues.createComment({
            owner, repo, issue_number: workRequest.issueNumber,
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
        console.log(`[diagnose] Type A (confidence ${result.value.confidence}) — proceeding to implement`);
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

      const label = routing.route === 'needs-spec-update' ? 'needs-spec-update' : 'needs-human';
      console.log(`[diagnose] ${routing.route} — labeling ${label}`);

      try {
        await octokit.issues.addLabels({
          owner, repo, issue_number: workRequest.issueNumber,
          labels: [label],
        });
        await octokit.issues.createComment({
          owner, repo, issue_number: workRequest.issueNumber,
          body: diagnosisComment,
        });
      } catch (e) {
        console.error(`[diagnose] Failed to update issue:`, e);
      }

      return 'failure';
    },

    implement: async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[implement] Starting for #${workRequest.issueNumber} on ${featureBranch}`);
      // Restore persisted handoff notes from RunState for retry attempts (ARCH-AC-HANDOFF step 6)
      const handoffNotes = run.handoffNotes
        ? new Map(Object.entries(run.handoffNotes))
        : undefined;
      const result = await coordinator.implement(workRequest, featureBranch, runWriter, runId, {
        handoffNotes,
        variant: run.variant,
        diagnosisDetail: run.diagnosisDetail,
        activePlugins,
      });
      if (!result.ok) { console.error(`[implement] Error:`, result.error.message); return 'failure'; }
      if (!result.value.success) {
        // Containment breach is terminal — signal pipeline to go stuck (STACK-AC-OPERATIONAL-SAFETY)
        if (result.value.containmentBreach) {
          console.error(`[implement] Containment breach detected:`, result.value.error);
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
      console.log(`[implement] Done, cost: $${result.value.totalCost.toFixed(2)}`);

      // Batch processor removes the workspace worktree in its finally block.
      // If workspaceDir no longer exists, fall back to mainRepoRoot for the review phase.
      // coordinator.implement() checks out featureBranch in the main repo for merging — restore
      // to staging branch so the review phase sees current dev code and passing test suite.
      const { existsSync: workspaceDirExists } = await import('node:fs');
      const restoreResult = await git(['checkout', config.branches.staging], mainRepoRoot);
      if (restoreResult.ok) {
        console.log(`[implement] Restored main repo to ${config.branches.staging}`);
      } else {
        console.warn(`[implement] Failed to restore branch to ${config.branches.staging}: ${restoreResult.error.message}`);
      }
      if (!workspaceDirExists(workspaceDir)) {
        // Batch removes the worktree but the branch still has commits.
        // Recreate the worktree so review runs in the correct directory.
        console.log(`[implement] Workspace removed by batch — recreating worktree for review`);
        const recreate = await git(['worktree', 'add', workspaceDir, featureBranch], mainRepoRoot);
        if (recreate.ok) {
          workspaceCwd = workspaceDir;
          run.workspacePath = workspaceDir;
          // Install dependencies so review gate commands (pnpm test, tsc) work
          const installResult = await runCommand('pnpm', ['install', '--frozen-lockfile'], {
            cwd: workspaceDir,
            timeoutMs: 120_000,
          });
          if (installResult.ok) {
            console.log(`[implement] Worktree recreated at ${workspaceDir} (deps installed)`);
          } else {
            console.warn(`[implement] Worktree recreated but pnpm install failed — review gate may fail`);
          }
        } else {
          console.warn(`[implement] Failed to recreate worktree: ${recreate.error.message} — falling back to repo root`);
          workspaceCwd = mainRepoRoot;
        }
      }

      return 'success';
    },

    review: async (run: RunState): Promise<PhaseEvent> => {
      await ensureWorkspace(run); const cwd = workspaceCwd;
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
      // Truncate to 50 KB to avoid excessive prompt size that causes reviewer timeouts.
      const DIFF_MAX_BYTES = 50_000;
      let diff: string | undefined;
      try {
        const diffResult = await git(['diff', config.branches.staging + '..' + featureBranch], workspaceCwd);
        if (diffResult.ok) {
          diff = diffResult.value.length > DIFF_MAX_BYTES
            ? diffResult.value.slice(0, DIFF_MAX_BYTES) + '\n\n[diff truncated — showing first 50 KB of ' + diffResult.value.length + ' bytes]'
            : diffResult.value;
        }
      } catch { /* diff is optional context */ }

      // Load actual spec content from .specify/ for reviewer (#122)
      const specifyRoot = join(cwd, '.specify');
      let specContent: string | undefined;
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[review] Failed to load spec content:`, e);
      }

      // Skip all gates if there's no diff (e.g., spec-only tasks with no code changes).
      // Running gate1 tests against the baseline codebase would fail on pre-existing
      // test failures unrelated to this branch — and spec tasks don't modify code.
      if (!diff || diff.trim().length === 0) {
        console.log(`[review] No code changes — skipping all gates`);
        return 'success';
      }

      // Create all four gates
      // Inject knowledge context (STACK-AC-VALIDATION: knowledge injection before reviewer spawn)
      let knowledgeContext: string | undefined;
      if (knowledgeStore) {
        try {
          const nameOnlyResult = await git(['diff', '--name-only', config.branches.staging + '..' + featureBranch], workspaceCwd);
          const artifactPaths = nameOnlyResult.ok
            ? nameOnlyResult.value.split('\n').filter(Boolean)
            : [];
          const ctx = await injectKnowledge(artifactPaths, knowledgeStore);
          if (ctx) knowledgeContext = ctx;
        } catch (e) {
          console.warn(`[review] Knowledge injection failed:`, e);
        }
      }

      const gate1 = createGate1(config.validation.gate1Commands);
      const gate2 = createReviewerGate(
        'spec-compliance', 'reviewer-spec',
        'Verify implementation against spec acceptance criteria.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff, specContent, activePlugins, knowledgeContext,
      );
      const gate3 = createReviewerGate(
        'quality', 'reviewer-quality',
        'Evaluate code quality, pattern consistency, and test quality.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff, undefined, activePlugins, knowledgeContext,
      );
      const gate4 = createReviewerGate(
        'security', 'reviewer-security',
        'Evaluate injection risks, authentication, data validation, and concurrency safety.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff, undefined, activePlugins, knowledgeContext,
      );

      // Select gates based on complexity and risk
      const gates = selectGates(complexity, riskSensitive, gate1, gate2, gate3, gate4);
      console.log(`[review] Selected ${gates.length} gates (complexity=${complexity}, riskSensitive=${riskSensitive})`);

      const result = await runReview(gates, cwd, {
        maxFixCycles: config.validation.maxFixCycles,
      });
      if (!result.passed) {
        if (result.escalated) {
          console.error(`[review] Escalated (${result.escalationReason ?? 'unknown'}):`, JSON.stringify(result.gateResults));
          return 'escalated';
        }
        // Track review failures across implement→review loop iterations.
        // Without a fixHandler, runReview returns immediately — escalation must be
        // handled here using accumulated fixAttempts from prior cycles.
        const reviewFailures = run.fixAttempts.filter(a => a.phase === 'review').length;
        const errorHash = result.gateResults.find(g => !g.passed)?.findings[0]?.description?.slice(0, 64) ?? 'unknown';
        run.fixAttempts.push({ phase: 'review', attempt: reviewFailures + 1, errorHash });
        if (reviewFailures + 1 >= config.validation.maxFixCycles) {
          console.error(`[review] Max fix cycles (${config.validation.maxFixCycles}) reached, escalating:`, JSON.stringify(result.gateResults));
          return 'escalated';
        }
        console.error(`[review] Failed (attempt ${reviewFailures + 1}/${config.validation.maxFixCycles}):`, JSON.stringify(result.gateResults));
        return 'failure';
      }
      console.log(`[review] Passed (${result.fixCycles} fix cycles)`);
      return 'success';
    },

    holdout: async (run: RunState): Promise<PhaseEvent> => {
      if (!config.validation.holdoutCommand) {
        console.log(`[holdout] No holdout command configured — skipping`);
        return 'success';
      }
      await ensureWorkspace(run); const cwd = workspaceCwd;
      console.log(`[holdout] Running holdout tests for #${workRequest.issueNumber}`);
      const result = await runHoldout(config.validation.holdoutCommand, featureBranch, cwd);
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
          specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
        } catch (e) {
          console.warn(`[holdout] Failed to load spec content:`, e);
        }
        let implementationContent = '';
        try {
          implementationContent = await loadImplementationContent(workRequest.specRefs, cwd);
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
              console.warn(`[holdout] Diagnosis session rate-limited: ${diagResult.error.message} — signaling pipeline to pause`);
              return 'rate-limited';
            }
            if (diagResult.error.containmentBreach) {
              console.warn(`[holdout] Diagnosis session containment breach: ${diagResult.error.message} — signaling pipeline`);
              return 'containment-breach';
            }
            if (diagResult.error.message.startsWith('Budget exceeded')) {
              console.warn(`[holdout] Diagnosis session budget exceeded: ${diagResult.error.message} — signaling pipeline to pause`);
              return 'budget-exceeded';
            }
          }
          console.error(`[holdout] Diagnosis failed:`, diagResult.error.message);
          try {
            await octokit.issues.addLabels({ owner, repo, issue_number: workRequest.issueNumber, labels: ['needs-human'] });
            await octokit.issues.createComment({
              owner, repo, issue_number: workRequest.issueNumber,
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
          const holdoutFailures = run.fixAttempts.filter(a => a.phase === 'holdout').length;
          run.fixAttempts.push({ phase: 'holdout', attempt: holdoutFailures + 1, errorHash: failedIds.slice(0, 64) });
          if (holdoutFailures + 1 >= config.validation.maxFixCycles) {
            console.error(`[holdout] Max fix cycles (${config.validation.maxFixCycles}) reached for Type A — escalating`);
            return 'escalated';
          }
          console.log(`[holdout] Diagnosis Type A (confidence ${diagResult.value.confidence}) — routing to fix cycle (attempt ${holdoutFailures + 1}/${config.validation.maxFixCycles})`);
          return 'failure';
        }

        // Type B or Type C / low confidence — post diagnosis and escalate to stuck
        const label = routing.route === 'needs-spec-update' ? 'needs-spec-update' : 'needs-human';
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
          await octokit.issues.addLabels({ owner, repo, issue_number: workRequest.issueNumber, labels: [label] });
          await octokit.issues.createComment({ owner, repo, issue_number: workRequest.issueNumber, body: diagnosisComment });
        } catch (e) {
          console.error(`[holdout] Failed to update issue:`, e);
        }
        return 'escalated';
      }
      console.log(`[holdout] All scenarios passed`);
      return 'success';
    },

    integrate: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(`[integrate] Merging ${featureBranch} into ${config.branches.staging}`);
      // Integration must run in mainRepoRoot (where staging is already checked out),
      // not workspaceCwd (worktree on featureBranch). Git prohibits checking out a branch
      // that's already checked out in another worktree — see #412.
      const result = await integrateToStaging(featureBranch, config.branches.staging, mainRepoRoot);
      if (!result.ok) {
        console.error(`[integrate] Error:`, result.error.message);
        return 'failure';
      }
      if (!result.value.success) {
        console.error(`[integrate] Failed:`, result.value.error);
        return 'failure';
      }
      console.log(`[integrate] Successfully merged to ${config.branches.staging}`);
      return 'success';
    },

    deploy: async (run: RunState): Promise<PhaseEvent> => {
      if (!config.validation.deployCommand || !config.validation.healthCheckUrl) {
        console.log(`[deploy] No deploy command or health check URL configured — skipping`);
        return 'success';
      }
      await ensureWorkspace(run); const cwd = workspaceCwd;
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
        console.error(`[deploy] Deploy status: ${result.value.status} after ${result.value.attempts} attempt(s)`);
        return 'failure';
      }
      console.log(`[deploy] Healthy after ${result.value.attempts} attempt(s)`);
      return 'success';
    },

    test: async (run: RunState): Promise<PhaseEvent> => {
      if (config.validation.testCommands.length === 0) {
        console.log(`[test] No post-deploy test commands configured — skipping`);
        return 'success';
      }
      await ensureWorkspace(run); const cwd = workspaceCwd;
      console.log(`[test] Running post-deploy tests for #${workRequest.issueNumber}`);
      const result = await runPostDeployTests({
        testCommands: config.validation.testCommands,
        maxFixAttempts: config.validation.maxTestFixAttempts,
        failureExcerptLines: config.validation.failureExcerptLines,
        cwd,
      });
      if (result.escalated) {
        console.error(`[test] Escalated after ${result.fixAttempts} fix attempt(s): ${result.failedCommand}`);
        run.fixAttempts.push({ phase: 'test', attempt: result.fixAttempts, errorHash: result.failureExcerpt ?? '' });
        return 'failure';
      }
      if (!result.passed) {
        console.error(`[test] Failed: ${result.failedCommand}`);
        run.fixAttempts.push({ phase: 'test', attempt: result.fixAttempts, errorHash: result.failureExcerpt ?? '' });
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

      // Report phase is best-effort: the implementation work is already done.
      // If any GitHub/notification call fails, log the error but still return
      // 'success' so the pipeline completes rather than going stuck.
      try {
        // Post report as comment
        await postReport(octokit, owner, repo, workRequest.issueNumber, reportBody);
      } catch (err) {
        console.error(`[report] postReport failed (non-fatal):`, err);
      }

      try {
        // Complete the work request (label + close)
        const completeResult = await detector.completeWork(workRequest.issueNumber, reportBody);
        if (!completeResult.ok) {
          console.error(`[report] completeWork failed (non-fatal):`, completeResult.error);
        }
      } catch (err) {
        console.error(`[report] completeWork failed (non-fatal):`, err);
      }

      try {
        // Append to results ledger
        await appendResult({
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
        }, stateDir);
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
