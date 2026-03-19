// src/control-plane/daemon.ts
import { Octokit } from '@octokit/rest';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import { createWorkDetector } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { runPipeline } from './pipeline.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { notify } from './notify.js';
import type { RunState, WorkRequest } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

export async function startDaemon(configPath: string): Promise<Result<void>> {
  // 1. Load config
  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  // 2. Initialize state
  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  // 3. Initialize services
  const costTracker = new CostTracker({
    dailyBudget: config.dailyBudget,
    perRunBudget: config.perRunBudget,
  });
  const runtime = new SessionRuntime(config, costTracker);
  const coordinator = new ImplementationCoordinator(runtime, process.cwd());

  // 4. Initialize GitHub client
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const detector = createWorkDetector(octokit, config.repo.owner, config.repo.name);

  // 5. State tracking
  let paused = false;
  let activeRuns = 0;
  let shuttingDown = false;

  // 6. Start control server
  const { server, start } = createControlServer(config.controlPort, {
    getStatus: () => ({
      activeRuns,
      dailyCost: costTracker.getDailyCost(),
      paused,
      uptime: process.uptime(),
    }),
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    retry: (_issueNumber) => {
      // TODO: implement retry logic
      return err(new Error('retry not yet implemented'));
    },
  });
  const serverResult = await start();
  if (!serverResult.ok) return serverResult;

  console.log(`Auto-Claude daemon started on port ${config.controlPort}`);

  // 7. Polling loop
  const poller = setInterval(async () => {
    if (paused || shuttingDown) return;
    if (activeRuns >= config.maxConcurrentRuns) return;

    // Check daily budget reset
    costTracker.maybeResetDaily();

    const workResult = await detector.detectReadyWork();
    if (!workResult.ok) return;

    for (const request of workResult.value) {
      if (activeRuns >= config.maxConcurrentRuns) break;
      if (paused || shuttingDown) break;

      // Claim the issue
      const claimResult = await detector.claimWork(request.issueNumber);
      if (!claimResult.ok) continue;

      activeRuns++;

      // Process in background (fire and forget)
      processWorkRequest(config, request, runtime, coordinator, costTracker, stateMgr, octokit, stateDir)
        .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
        .finally(() => { activeRuns--; });
    }
  }, config.pollIntervalMs);

  // 8. Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    clearInterval(poller);
    // Wait for active runs (up to grace period)
    const deadline = Date.now() + config.gracePeriodMs;
    while (activeRuns > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    server.close();
    console.log('Daemon stopped.');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return ok(undefined);
}

async function processWorkRequest(
  config: Config,
  request: WorkRequest,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  costTracker: CostTracker,
  stateMgr: StateManager,
  octokit: Octokit,
  stateDir: string,
): Promise<void> {
  // Create run state
  const run: RunState = {
    issueNumber: request.issueNumber,
    title: request.title,
    phase: getStartPhase('feature-simple'),
    variant: 'feature-simple', // MVP: always simple
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: config.perRunBudget,
    fixAttempts: [],
    errorHashes: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await stateMgr.saveRunState(run);

  const handlers = createPhaseHandlers(config, runtime, coordinator, octokit, request, stateDir);
  const table = getPipeline('feature-simple');

  const result = await runPipeline(run, table, handlers, stateMgr, costTracker);

  if (result.outcome === 'stuck') {
    const detector = createWorkDetector(octokit, config.repo.owner, config.repo.name);
    await detector.markStuck(request.issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, {
      event: 'stuck',
      issueNumber: request.issueNumber,
      phase: run.phase,
      message: `Issue #${request.issueNumber} stuck: ${result.error ?? 'unknown'}`,
    });
  }
}
