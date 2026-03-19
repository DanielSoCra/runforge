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
      console.log(`[detect] Creating branch ${featureBranch} from ${config.branches.staging}`);
      await git(['checkout', config.branches.staging]);
      const branchResult = await git(['checkout', '-b', featureBranch, config.branches.staging]);
      if (!branchResult.ok) {
        console.log(`[detect] Branch exists, checking out`);
        const co = await git(['checkout', featureBranch]);
        if (!co.ok) { console.error(`[detect] Checkout failed:`, co.error.message); return 'failure'; }
      }
      return 'success';
    },

    classify: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(`[classify] MVP: returning simple`);
      return 'success:simple';
    },

    implement: async (run: RunState): Promise<PhaseEvent> => {
      console.log(`[implement] Starting for #${workRequest.issueNumber} on ${featureBranch}`);
      const result = await coordinator.implement(workRequest, featureBranch);
      if (!result.ok) { console.error(`[implement] Error:`, result.error.message); return 'failure'; }
      if (!result.value.success) { console.error(`[implement] Failed:`, result.value.error); return 'failure'; }
      run.cost += result.value.totalCost;
      console.log(`[implement] Done, cost: $${result.value.totalCost.toFixed(2)}`);
      return 'success';
    },

    review: async (_run: RunState): Promise<PhaseEvent> => {
      console.log(`[review] Running gate 1 in ${process.cwd()}`);
      const gates: Gate[] = [createGate1(config.validation.gate1Commands)];
      const result = await runReview(gates, process.cwd());
      if (!result.passed) { console.error(`[review] Failed:`, JSON.stringify(result.gateResults)); return 'failure'; }
      console.log(`[review] Passed`);
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
