import { Octokit } from '@octokit/rest';
import { loadConfig } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createWorkDetector } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { runPipeline } from './pipeline.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { selectVariant } from './variants.js';
import { notify } from './notify.js';
import type { RunState } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

export async function processSingleIssue(issueNumber: number, configPath: string): Promise<Result<void>> {
  console.log(`[process] Processing issue #${issueNumber}`);

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  const costTracker = new CostTracker({ dailyBudget: config.dailyBudget, perRunBudget: config.perRunBudget });
  const runtime = new SessionRuntime(config, costTracker);
  const coordinator = new ImplementationCoordinator(runtime, process.cwd());
  if (!config.repo) return err(new Error('config.repo is required for single-issue processing'));
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const { owner, name: repo } = config.repo;
  const detector = createWorkDetector(octokit, owner, repo);

  let issueData;
  try {
    const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    issueData = data;
  } catch (e) {
    return err(new Error(`Failed to fetch issue #${issueNumber}: ${e instanceof Error ? e.message : String(e)}`));
  }

  const request = {
    issueNumber,
    title: issueData.title,
    body: issueData.body ?? '',
    labels: issueData.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    specRefs: (issueData.body ?? '').match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g) ?? [],
  };

  console.log(`[process] Claiming issue #${issueNumber}`);
  await detector.claimWork(issueNumber);

  const variant = selectVariant(request);
  const run: RunState = {
    id: crypto.randomUUID(),
    issueNumber, title: request.title,
    phase: getStartPhase(variant), variant,
    phaseCompletions: {}, checkpoints: [], cost: 0,
    perRunBudget: config.perRunBudget, fixAttempts: [], errorHashes: {},
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await stateMgr.saveRunState(run);

  console.log(`[process] Running pipeline for #${issueNumber}: ${request.title}`);
  const handlers = createPhaseHandlers(config, owner, repo, runtime, coordinator, octokit, request, stateDir);
  const table = getPipeline(variant);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
  console.log(`[process] Result: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);

  if (result.outcome === 'stuck') {
    await detector.markStuck(issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, { event: 'stuck', issueNumber, phase: run.phase, message: `Issue #${issueNumber} stuck` });
    return err(new Error(`Pipeline stuck: ${result.error}`));
  }
  return ok(undefined);
}
