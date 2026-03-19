// src/control-plane/phases.ts
import type { PhaseHandlerMap } from './pipeline.js';
import type { RunState, PhaseEvent, WorkRequest } from '../types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { Config } from '../config.js';
import { createGate1, type Gate } from '../validation/gates.js';
import { runReview } from '../validation/review.js';
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import type { Octokit } from '@octokit/rest';
import { createWorkDetector } from './work-detection.js';
import { git } from '../lib/git.js';

export function createPhaseHandlers(
  config: Config,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  octokit: Octokit,
  workRequest: WorkRequest,
  stateDir: string,
): PhaseHandlerMap {
  const { owner, name: repo } = config.repo;
  const detector = createWorkDetector(octokit, owner, repo);
  const featureBranch = `feature/${workRequest.issueNumber}`;

  return {
    detect: async (_run: RunState): Promise<PhaseEvent> => {
      // detect phase: create feature branch from staging
      const branchResult = await git(['checkout', '-b', featureBranch, config.branches.staging]);
      if (!branchResult.ok) {
        // Branch may already exist (crash recovery)
        await git(['checkout', featureBranch]);
      }
      return 'success';
    },

    classify: async (_run: RunState): Promise<PhaseEvent> => {
      // MVP: always classify as simple (skip decomposition)
      return 'success:simple';
    },

    implement: async (run: RunState): Promise<PhaseEvent> => {
      const result = await coordinator.implement(workRequest, featureBranch);
      if (!result.ok) return 'failure';
      if (!result.value.success) return 'failure';
      run.cost += result.value.totalCost;
      return 'success';
    },

    review: async (run: RunState): Promise<PhaseEvent> => {
      const gates: Gate[] = [createGate1(config.validation.gate1Commands)];
      const result = await runReview(gates, featureBranch);
      if (!result.passed) return 'failure';
      return 'success';
    },

    report: async (run: RunState): Promise<PhaseEvent> => {
      const outcome = 'complete';
      const reportBody = formatReport(run, outcome);

      // Post report as comment
      await postReport(octokit, owner, repo, workRequest.issueNumber, reportBody);

      // Complete the work request (label + close)
      await detector.completeWork(workRequest.issueNumber, reportBody);

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
      }, stateDir);

      // Notify
      await notify(config.webhooks, {
        event: 'complete',
        issueNumber: workRequest.issueNumber,
        message: `Issue #${workRequest.issueNumber} completed ($${run.cost.toFixed(2)})`,
      });

      return 'success';
    },
  };
}
