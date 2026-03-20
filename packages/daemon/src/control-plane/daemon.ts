// src/control-plane/daemon.ts
import { createClient } from '@supabase/supabase-js';
import { Octokit } from '@octokit/rest';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import { RepoManager } from './repo-manager.js';
import { createWorkDetector, type WorkDetector } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { createWebsitePhaseHandlers } from './phases-website.js';
import { readAgencyConfig } from './agency-config.js';
import { runPipeline } from './pipeline.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { selectVariant } from './variants.js';
import { notify } from './notify.js';
import type { RunState, WorkRequest } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';
import { RemoteControlManager } from './remote-control.js';

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

  // 3b. Start Remote Control
  const remoteControl = new RemoteControlManager();
  remoteControl.start();

  // 4. State tracking
  let paused = false;
  let activeRuns = 0;
  let shuttingDown = false;

  // 5. Build RepoManager or legacy single-repo detector
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let repoManager: RepoManager | null = null;
  let legacyDetector: WorkDetector | null = null;

  if (supabaseUrl && supabaseKey) {
    // DB mode
    const supabase = createClient(supabaseUrl, supabaseKey);
    repoManager = new RepoManager(
      supabase,
      config.pollIntervalMs,
      async (repoId, owner, name, detector) => {
        if (paused || shuttingDown) return;
        if (activeRuns >= config.maxConcurrentRuns) return;
        costTracker.maybeResetDaily();
        const workResult = await detector.detectReadyWork();
        if (!workResult.ok) {
          // TODO: proactive token health check — if 401, mark connection token_invalid
          return;
        }
        for (const request of workResult.value) {
          if (activeRuns >= config.maxConcurrentRuns) break;
          if (paused || shuttingDown) break;
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          processWorkRequest(config, owner, name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir)
            .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
            // CRITICAL: notifyRunEnd must be in .finally(), never only in .catch() or .then().
            // If it is missing here, a disabled repo's poller hangs in pendingDisable forever.
            .finally(() => {
              activeRuns--;
              repoManager!.notifyRunEnd(repoId);
            });
        }
      },
    );

    // If config.repo is present, upsert it as a seed repo
    if (config.repo) {
      const upsertResult = await repoManager.upsertRepo(config.repo.owner, config.repo.name);
      if (!upsertResult.ok) {
        console.warn(`[daemon] Could not upsert seed repo from config: ${upsertResult.error.message}`);
      }
    }

    const initResult = await repoManager.initialize();
    if (!initResult.ok) {
      await remoteControl.stop();
      return initResult;
    }
  } else {
    // Legacy mode: config.repo required
    if (!config.repo) {
      await remoteControl.stop();
      return err(new Error(
        'No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set and no config.repo — cannot determine repos to poll'
      ));
    }
    const legacyOctokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    legacyDetector = createWorkDetector(legacyOctokit, config.repo.owner, config.repo.name);
  }

  // 6. Start control server
  const { server, start } = createControlServer(config.controlPort, {
    getStatus: () => ({
      activeRuns,
      dailyCost: costTracker.getDailyCost(),
      paused,
      uptime: process.uptime(),
      ...remoteControl.getState(),
    }),
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    retry: (_issueNumber) => err(new Error('retry not yet implemented')),
    reloadRepos: repoManager
      ? async () => repoManager!.reload()
      : undefined,
  });
  const serverResult = await start();
  if (!serverResult.ok) {
    repoManager?.stop();
    await remoteControl.stop();
    return serverResult;
  }

  console.log(`Auto-Claude daemon started on port ${config.controlPort}`);

  // 7. Legacy polling loop (only used when repoManager is null)
  let legacyPoller: ReturnType<typeof setInterval> | null = null;
  if (legacyDetector) {
    const detector = legacyDetector;
    legacyPoller = setInterval(async () => {
      if (paused || shuttingDown) return;
      if (activeRuns >= config.maxConcurrentRuns) return;
      costTracker.maybeResetDaily();
      const workResult = await detector.detectReadyWork();
      if (!workResult.ok) return;
      for (const request of workResult.value) {
        if (activeRuns >= config.maxConcurrentRuns) break;
        if (paused || shuttingDown) break;
        const claimResult = await detector.claimWork(request.issueNumber);
        if (!claimResult.ok) continue;
        activeRuns++;
        processWorkRequest(config, config.repo!.owner, config.repo!.name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir)
          .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
          .finally(() => { activeRuns--; });
      }
    }, config.pollIntervalMs);
  }

  // 8. Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    if (legacyPoller) clearInterval(legacyPoller);
    repoManager?.stop();
    const deadline = Date.now() + config.gracePeriodMs;
    while (activeRuns > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await remoteControl.stop();
    server.close();
    console.log('Daemon stopped.');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return ok(undefined);
}

async function processWorkRequest(
  config: Config,
  owner: string,
  repoName: string,
  request: WorkRequest,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  costTracker: CostTracker,
  stateMgr: StateManager,
  detector: WorkDetector,
  stateDir: string,
): Promise<void> {
  const variant = selectVariant(request);
  const run: RunState = {
    issueNumber: request.issueNumber,
    title: request.title,
    phase: getStartPhase(variant),
    variant,
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

  // Build a notifyOctokit from env for phase handlers
  const notifyOctokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const agencyConfig = await readAgencyConfig(null, '');
  // TODO: pass real supabase client and repoId once available from daemon context
  const handlers = variant === 'website'
    ? createWebsitePhaseHandlers(
        agencyConfig,
        null,          // supabase — wired in follow-on
        notifyOctokit,
        owner,
        repoName,
        request.issueNumber,
        null,          // repoId — wired in follow-on
      )
    : createPhaseHandlers(config, owner, repoName, runtime, coordinator, notifyOctokit, request, stateDir);
  const table = getPipeline(variant);

  console.log(`[daemon] Pipeline start for #${request.issueNumber}: ${request.title}`);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker);
  console.log(`[daemon] Pipeline done for #${request.issueNumber}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);

  if (result.outcome === 'stuck') {
    await detector.markStuck(request.issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, {
      event: 'stuck',
      issueNumber: request.issueNumber,
      phase: run.phase,
      message: `Issue #${request.issueNumber} stuck: ${result.error ?? 'unknown'}`,
    });
  }
}
