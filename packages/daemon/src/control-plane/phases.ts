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
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import type { Octokit } from '@octokit/rest';
import { createWorkDetector } from './work-detection.js';
import { git } from '../lib/git.js';
import { join } from 'node:path';
import { diagnose } from '../diagnosis/diagnostician.js';
import { routeDiagnosis } from '../diagnosis/router.js';
import { loadSpecContent } from '../infra/spec-loader.js';

// Serializes detect-phase git operations across concurrent pipeline runs.
// Same pattern as integrationLock in integration.ts — single-process boolean suffices.
let detectLock = false;

export function acquireDetectLock(): boolean {
  if (detectLock) return false;
  detectLock = true;
  return true;
}

export function releaseDetectLock(): void {
  detectLock = false;
}

export function isDetectLocked(): boolean {
  return detectLock;
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
  runWriter?: SupabaseRunWriter,
  runId?: string,
  repoRoot?: string,
): PhaseHandlerMap {
  const repo = repoName;
  const detector = createWorkDetector(octokit, owner, repo);
  const featureBranch = `feature/${workRequest.issueNumber}`;

  return {
    detect: async (_run: RunState): Promise<PhaseEvent> => {
      if (!acquireDetectLock()) {
        console.error(`[detect] Lock held by another run — aborting`);
        return 'failure';
      }
      try {
        console.log(`[detect] Creating branch ${featureBranch} from ${config.branches.staging}`);
        await git(['checkout', config.branches.staging], repoRoot);
        const branchResult = await git(['checkout', '-b', featureBranch, config.branches.staging], repoRoot);
        if (!branchResult.ok) {
          console.log(`[detect] Branch exists, checking out`);
          const co = await git(['checkout', featureBranch], repoRoot);
          if (!co.ok) { console.error(`[detect] Checkout failed:`, co.error.message); return 'failure'; }
        }
        return 'success';
      } finally {
        releaseDetectLock();
      }
    },

    classify: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(`[classify] MVP: returning simple`);
      return 'success:simple';
    },

    diagnose: async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[diagnose] Running diagnosis for #${workRequest.issueNumber}`);
      const threshold = config.diagnosis.confidenceThreshold;

      const result = await diagnose(
        runtime,
        workRequest.issueNumber,
        workRequest.body,
        '',  // implementation content — not yet available at this phase
        workRequest.specRefs.join('\n'),
        runWriter,
        runId,
        repoRoot,
      );

      if (!result.ok) {
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

      // Record diagnosis on run state for results ledger
      run.diagnosisType = result.value.type;
      run.diagnosisConfidence = result.value.confidence;

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
      });
      if (!result.ok) { console.error(`[implement] Error:`, result.error.message); return 'failure'; }
      if (!result.value.success) {
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
      return 'success';
    },

    review: async (run: RunState): Promise<PhaseEvent> => {
      const cwd = repoRoot ?? process.cwd();
      console.log(`[review] Running review gates in ${cwd}`);

      // Derive complexity from pipeline variant
      const complexity: 'simple' | 'standard' | 'complex' =
        run.variant === 'feature' ? 'standard' : 'simple';

      // Determine risk sensitivity from work request metadata
      const riskSensitive = isRiskSensitive(
        workRequest.labels,
        workRequest.body + ' ' + (workRequest.scopeDescription ?? ''),
        [], // artifact paths — not tracked on WorkRequest yet
      );

      // Build diff for reviewer context
      let diff: string | undefined;
      try {
        const diffResult = await git(['diff', config.branches.staging + '..HEAD'], repoRoot);
        if (diffResult.ok) diff = diffResult.value;
      } catch { /* diff is optional context */ }

      // Load actual spec content from .specify/ for reviewer (#122)
      const specifyRoot = join(cwd, '.specify');
      let specContent: string | undefined;
      try {
        specContent = await loadSpecContent(workRequest.specRefs, specifyRoot);
      } catch (e) {
        console.warn(`[review] Failed to load spec content:`, e);
      }

      // Create all four gates
      const gate1 = createGate1(config.validation.gate1Commands);
      const gate2 = createReviewerGate(
        'spec-compliance', 'reviewer-spec',
        'Verify implementation against spec acceptance criteria.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff, specContent || undefined,
      );
      const gate3 = createReviewerGate(
        'quality', 'reviewer-quality',
        'Evaluate code quality, pattern consistency, and test quality.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff,
      );
      const gate4 = createReviewerGate(
        'security', 'reviewer-security',
        'Evaluate injection risks, authentication, data validation, and concurrency safety.',
        runtime, workRequest.issueNumber, runWriter, runId,
        diff,
      );

      // Select gates based on complexity and risk
      const gates = selectGates(complexity, riskSensitive, gate1, gate2, gate3, gate4);
      console.log(`[review] Selected ${gates.length} gates (complexity=${complexity}, riskSensitive=${riskSensitive})`);

      const result = await runReview(gates, cwd, {
        maxFixCycles: config.validation.maxFixCycles,
      });
      if (!result.passed) { console.error(`[review] Failed:`, JSON.stringify(result.gateResults)); return 'failure'; }
      console.log(`[review] Passed (${result.fixCycles} fix cycles)`);
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
        await detector.completeWork(workRequest.issueNumber, reportBody);
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
