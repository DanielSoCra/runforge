import { Octokit } from '@octokit/rest';
import { loadConfig } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createWorkDetector, type FeaturePipelineWorkType } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { createDeploymentRegistry } from './deployment-registry/index.js';
import { runPipeline } from './pipeline.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { selectVariant } from './variants.js';
import { notify } from './notify.js';
import type { RunState, DetectedWorkType } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';
import { createPhaseLabelMirror } from './phase-labels.js';

/** Feature-pipeline label → work type mapping. Checked in priority order. */
const FEATURE_PIPELINE_TIERS: ReadonlyArray<{ required: string; workType: FeaturePipelineWorkType }> = [
  { required: 'ready-to-implement', workType: 'implementation' },
  { required: 'l2-approved', workType: 'l3-generate' },
  { required: 'l2-in-progress', workType: 'l2-brainstorm' },
  { required: 'l1-approved', workType: 'l2-brainstorm' },
];

export type ClaimAction =
  | { type: 'standard' }
  | { type: 'bug-fix' }
  | { type: 'feature-pipeline'; workType: FeaturePipelineWorkType };

/**
 * Infers work type from issue labels so selectVariant can route correctly.
 * Mirrors the detection logic in daemon.ts polling (detectBugFixWork, detectFeaturePipelineWork).
 */
export function inferWorkType(labels: string[]): DetectedWorkType | undefined {
  const labelSet = new Set(labels);
  if (labelSet.has('review-finding')) return 'bug-fix';
  if (labelSet.has('feature-pipeline')) {
    const tier = FEATURE_PIPELINE_TIERS.find(t => labelSet.has(t.required));
    if (tier) return tier.workType;
  }
  return undefined;
}

/** Determines the correct claim action based on variant and labels. */
export function resolveClaimAction(variant: string, labels: string[]): ClaimAction {
  if (variant === 'bug') return { type: 'bug-fix' };
  if (variant === 'spec-driven' && labels.includes('feature-pipeline')) {
    const labelSet = new Set(labels);
    const tier = FEATURE_PIPELINE_TIERS.find(t => labelSet.has(t.required));
    if (tier) return { type: 'feature-pipeline', workType: tier.workType };
  }
  return { type: 'standard' };
}

export async function processSingleIssue(issueNumber: number, configPath: string): Promise<Result<void>> {
  console.log(`[process] Processing issue #${issueNumber}`);

  if (!process.env.GITHUB_TOKEN) {
    return err(new Error(
      'GITHUB_TOKEN environment variable is not set. Required for GitHub API access.',
    ));
  }

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  const deploymentRegistry = createDeploymentRegistry();
  if (config.deployment !== undefined) {
    const registered = deploymentRegistry.register(
      config.deployment.id,
      config.deployment.profile,
    );
    if (!registered.ok) {
      console.error(
        `[process] Deployment registration failed for ${config.deployment.id}: ${registered.offenders.join('; ')}`,
      );
    }
  }

  const { preloadGovernanceContext } = await import('../session-runtime/governance-context.js');
  try {
    await preloadGovernanceContext(config, process.cwd());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  const costTracker = new CostTracker({ dailyBudget: config.dailyBudget, perRunBudget: config.perRunBudget });
  const runtime = new SessionRuntime(config, costTracker);
  const repoRoot = process.cwd();
  const coordinator = new ImplementationCoordinator(runtime, repoRoot);
  if (!config.repo) return err(new Error('config.repo is required for single-issue processing'));
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const { owner, name: repo } = config.repo;
  const detector = createWorkDetector(octokit, owner, repo);
  const phaseLabelMirror = createPhaseLabelMirror(octokit, owner, repo);
  void phaseLabelMirror.provisionLabels();

  let issueData;
  try {
    const { data } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    issueData = data;
  } catch (e) {
    return err(new Error(`Failed to fetch issue #${issueNumber}: ${e instanceof Error ? e.message : String(e)}`));
  }

  const labels = issueData.labels.map((l) => (typeof l === 'string' ? l : l.name ?? ''));
  const request = {
    issueNumber,
    title: issueData.title,
    body: issueData.body ?? '',
    labels,
    specRefs: (issueData.body ?? '').match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g) ?? [],
    workType: inferWorkType(labels),
  };

  const variant = selectVariant(request);

  // Dispatch to the correct claim function based on variant (matches daemon.ts polling behavior)
  const claimAction = resolveClaimAction(variant, request.labels);
  console.log(`[process] Claiming issue #${issueNumber} (variant: ${variant}, claim: ${claimAction.type})`);
  if (claimAction.type === 'bug-fix') {
    await detector.claimBugFixWork(issueNumber);
  } else if (claimAction.type === 'feature-pipeline') {
    await detector.claimFeaturePipelineWork(issueNumber, claimAction.workType);
  } else {
    await detector.claimWork(issueNumber);
  }
  const run: RunState = {
    id: crypto.randomUUID(),
    issueNumber, title: request.title,
    phase: getStartPhase(variant), variant,
    phaseCompletions: {}, checkpoints: [], cost: 0,
    perRunBudget: config.perRunBudget, fixAttempts: [], errorHashes: {},
    body: request.body, labels: request.labels, specRefs: request.specRefs,
    deploymentId: config.deployment?.id,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await stateMgr.saveRunState(run);

  console.log(`[process] Running pipeline for #${issueNumber}: ${request.title}`);
  const handlers = createPhaseHandlers(
    config,
    owner,
    repo,
    runtime,
    coordinator,
    octokit,
    request,
    stateDir,
    undefined,
    undefined,
    repoRoot,
    undefined,
    undefined,
    phaseLabelMirror,
    undefined,
    undefined,
    deploymentRegistry,
  );
  const table = getPipeline(variant);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker, undefined, undefined, phaseLabelMirror);
  console.log(`[process] Result: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);

  if (result.outcome === 'stuck') {
    await detector.markStuck(issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, { event: 'stuck', issueNumber, phase: run.phase, message: `Issue #${issueNumber} stuck` });
    return err(new Error(`Pipeline stuck: ${result.error}`));
  }
  return ok(undefined);
}
