// src/control-plane/daemon.ts
import { isIP } from 'node:net';
import { Octokit } from '@octokit/rest';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import { RepoManager } from './repo-manager.js';
import { createWorkDetector, type WorkDetector, type FeaturePipelineWorkType } from './work-detection.js';
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
import { getSupabaseClient } from '../supabase/client.js';
import { SupabaseConfigReader } from '../supabase/config-reader.js';
import { SupabaseRunWriter, toDbOutcome } from '../supabase/run-writer.js';
import { GotchaStore } from '../knowledge/gotcha-store.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { DEFAULT_POLICIES } from '../knowledge/policy-registry.js';
import { join } from 'path';
import { createReviewScheduler } from '../coordination/review-scheduler.js';
import { createPOAgent } from '../coordination/po-agent.js';
import { createTechLeadScheduler } from '../coordination/tech-lead-scheduler.js';
import { createCoordinator, type CoordinatorConfig } from '../coordination/coordinator.js';
import { createWorkClaimer } from '../coordination/work-claimer.js';
import { createBatchManager } from '../coordination/batch-manager.js';
import { createMergeAgent } from '../coordination/merge-agent.js';
import { createMergeQueue } from '../coordination/merge-queue.js';
import { statfs } from 'fs/promises';
import { TechProposalStore } from '../coordination/tech-lead/proposal-store.js';
import { assembleSignalDigest } from '../coordination/tech-lead/signal-digest.js';
import { isTerminalStatus } from '../coordination/tech-lead/proposal-lifecycle.js';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import { mkdir } from 'fs/promises';
import type { Proposal, IdeaSubmission } from '../coordination/types.js';

export async function startDaemon(configPath: string): Promise<Result<void>> {
  // 0. Validate GITHUB_TOKEN — required for Octokit (labeling, commenting, notifications)
  if (!process.env.GITHUB_TOKEN) {
    return err(new Error(
      'GITHUB_TOKEN environment variable is not set. The daemon requires a GitHub token to interact with issues and pull requests.',
    ));
  }

  // 1. Load config
  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  // 2. Initialize state
  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  // Initialize Supabase layer (optional — daemon works without it in legacy mode)
  const supabase = getSupabaseClient();
  let configReader: SupabaseConfigReader | null = null;
  let runWriter: SupabaseRunWriter | null = null;

  if (supabase) {
    configReader = new SupabaseConfigReader(supabase);
    await configReader.start(); // throws if unreachable — prevents silent misconfiguration
    runWriter = new SupabaseRunWriter(supabase);
  }

  // 3. Initialize services
  const costTracker = new CostTracker({
    dailyBudget: configReader?.getGlobalConfig()?.dailyBudgetLimit ?? config.dailyBudget,
    perRunBudget: config.perRunBudget, // per-run budget is repo-specific, handled per-run
  });
  const runtime = new SessionRuntime(config, costTracker);
  const gotchaStore = new GotchaStore(join(stateDir, 'gotchas.jsonl'));
  const knowledgeStore = new KnowledgeStore(join(stateDir, 'knowledge.jsonl'), DEFAULT_POLICIES);
  const repoRoot = process.cwd();
  const coordinator = new ImplementationCoordinator(runtime, repoRoot, 300, 2000, gotchaStore, knowledgeStore);

  // 3b. Start Remote Control
  const remoteControl = new RemoteControlManager();
  remoteControl.start();

  // 3c. Start Review Scheduler
  const reviewScheduler = createReviewScheduler(
    {
      spawnReviewSession: async (category, maxIssues) => {
        const result = await runtime.spawnSession(
          'codebase-reviewer',
          { variables: { category, maxIssues: String(maxIssues), rubric: '', recentCommits: '' } },
          0, // no issue number — proactive review
        );
        if (!result.ok) {
          console.error('[review-scheduler] session failed:', result.error.message);
          return { findingsCount: 0, issuesCreated: 0 };
        }
        // Parse structured data from session output if available
        const data = result.value.structuredData as { findingsCount?: number; issuesCreated?: number } | null;
        return {
          findingsCount: data?.findingsCount ?? 0,
          issuesCreated: data?.issuesCreated ?? 0,
        };
      },
      getSignalRatio: () => {
        // TODO(#285): compute from historical review issue data (verified / total closed)
        // Default to 1.0 (no throttling) until signal tracking is implemented
        return 1.0;
      },
    },
    {
      intervalMs: config.coordination.reviewerInterval,
      signalRatioThreshold: config.validation.proactiveThrottleThreshold,
      maxIssuesPerCycle: 5,
    },
  );
  const stopReviewScheduler = reviewScheduler.start();

  // 3d. Start PO Agent
  const poStateDir = join(stateDir, 'coordination', 'product-owner');
  await mkdir(poStateDir, { recursive: true });
  const proposalsPath = join(poStateDir, 'proposals.json');
  const ideasPath = join(poStateDir, 'ideas.json');

  const poAgent = createPOAgent(
    {
      loadProposals: async () => {
        const result = await readJsonSafe<Proposal[]>(proposalsPath);
        return result.ok ? result.value : [];
      },
      saveProposals: async (proposals) => {
        await writeJsonSafe(proposalsPath, proposals);
      },
      loadIdeas: async () => {
        const result = await readJsonSafe<IdeaSubmission[]>(ideasPath);
        return result.ok ? result.value : [];
      },
      saveIdeas: async (ideas) => {
        await writeJsonSafe(ideasPath, ideas);
      },
      spawnPOSession: async () => {
        const result = await runtime.spawnSession('product-owner', { variables: {} }, 0);
        if (!result.ok) {
          console.error('[po-agent] session failed:', result.error.message);
        }
      },
    },
    {
      intervalMs: config.coordination.poInterval,
      debounceMs: config.coordination.poIdeaDebounce,
    },
  );
  let stopPOAgent: (() => void) | null = null;
  if (!config.coordination.useCoordinator) {
    stopPOAgent = poAgent.start();
  }

  // 3e. Start Tech Lead Scheduler
  const techLeadStateDir = join(stateDir, 'coordination', 'tech-lead');
  const techLeadProposalsDir = join(techLeadStateDir, 'proposals');
  const techLeadEnrichmentsDir = join(techLeadStateDir, 'enrichments');
  await mkdir(techLeadProposalsDir, { recursive: true });
  await mkdir(techLeadEnrichmentsDir, { recursive: true });

  const techProposalStore = new TechProposalStore(techLeadProposalsDir, techLeadEnrichmentsDir);
  await techProposalStore.init();

  const techLeadScheduler = createTechLeadScheduler(
    {
      assembleDigest: async (trigger, cfg) => {
        return assembleSignalDigest(trigger, {
          getReviewFindings: async () => [],
          getRunOutcomes: async () => [],
          getTestHealth: async () => [],
          getActiveProposals: async () => techProposalStore.loadActiveProposals(),
          getPriorRejections: async () => techProposalStore.loadRejectedProposals(),
        }, {
          lookbackWindowMs: cfg.lookbackWindowMs,
          maxEntriesPerSection: cfg.maxEntriesPerSection,
          deferredWorkPaths: [join(repoRoot, 'packages')],
          deferredWorkExclude: ['node_modules', 'dist', '.git', 'coverage', '.next'],
          workspacePath: repoRoot,
          traceabilityPath: join(repoRoot, '.specify', 'traceability.yml'),
        });
      },
      spawnTechLeadSession: async (digest) => {
        const result = await runtime.spawnSession(
          'tech-lead',
          { variables: { signal_digest: JSON.stringify(digest) } },
          0,
        );
        if (!result.ok) {
          throw new Error(`Tech Lead session failed: ${result.error.message}`);
        }
        return typeof result.value.structuredData === 'string'
          ? result.value.structuredData
          : JSON.stringify(result.value.structuredData ?? { proposals: [], protocolTriggers: [] });
      },
      storeProposals: async (proposals) => {
        let stored = 0;
        for (const proposal of proposals) {
          const duplicate = await techProposalStore.findDuplicate(proposal.proposalType, proposal.affectedAreas);
          if (duplicate) {
            const updated = { ...duplicate, evidence: [...duplicate.evidence, ...proposal.evidence] };
            await techProposalStore.saveProposal(updated);
          } else {
            await techProposalStore.saveProposal(proposal);
          }
          stored++;
        }
        return stored;
      },
      sweepExpiredProposals: async () => {
        const all = await techProposalStore.loadAllProposals();
        const now = Date.now();
        let swept = 0;
        for (const proposal of all) {
          if (!isTerminalStatus(proposal.status) && new Date(proposal.expiresAt).getTime() <= now) {
            await techProposalStore.saveProposal({ ...proposal, status: 'expired' });
            swept++;
          }
        }
        return swept;
      },
      // TODO(#344): Wire to ProtocolExecutor when available
      routeToProtocol: async (trigger) => {
        console.log(`[tech-lead-scheduler] protocol trigger: ${trigger} (routing not yet wired)`);
      },
    },
    {
      intervalMs: config.coordination.techLeadInterval,
      eventDebounceMs: config.coordination.techLeadEventDebounce,
      proposalExpiryMs: config.coordination.techLeadProposalExpiryMs,
      lookbackWindowMs: config.coordination.techLeadLookbackWindowMs,
      maxEntriesPerSection: config.coordination.techLeadMaxEntriesPerSection,
    },
  );
  let stopTechLeadScheduler: (() => void) | null = null;
  if (!config.coordination.useCoordinator) {
    stopTechLeadScheduler = techLeadScheduler.start();
  }

  // 3f. Coordinator (feature-flagged)
  let stopCoordinator: (() => void) | null = null;
  if (config.coordination.useCoordinator) {
    const workClaimer = createWorkClaimer(stateDir);
    const batchManager = createBatchManager(stateDir);
    const mergeQueue = createMergeQueue(stateDir);
    const mergeAgent = createMergeAgent(
      {
        queue: mergeQueue,
        git: async (args: string[], cwd?: string) => ok('' as string),
        resolveConflicts: async (_cwd, _cfg, _session) => ({ resolved: false, needsHuman: true }),
        validate: async (_issueNumber, _signal) => ok(undefined as void),
        resolveSession: async (_files, _cwd) => ok(undefined as void),
        integrationBranch: config.branches.staging,
        mergeWorktreePath: join(stateDir, 'coordination', 'merge-worktree'),
      },
      {
        pollIntervalMs: config.coordination.mergePollInterval,
        maxPollIntervalMs: config.coordination.mergePollMaxInterval,
        conflictFileThreshold: config.coordination.conflictFileThreshold,
        conflictLineThreshold: config.coordination.conflictLineThreshold,
        validationTimeoutMs: config.coordination.mergeValidationTimeout,
        dependencyTimeoutMs: config.coordination.mergeDependencyTimeout,
      },
    );

    const coordinatorConfig: CoordinatorConfig = {
      tickIntervalMs: config.coordination.tickInterval,
      maxAgents: config.coordination.maxAgents,
      diskSpaceThreshold: config.coordination.diskSpaceThreshold,
      perRepoLimits: {},
    };

    const coord = createCoordinator(
      {
        workClaimer,
        batchManager,
        mergeAgent,
        spawnWorker: async () => { /* wired in future — processWorkRequest will be called here */ },
        checkDiskSpace: async () => {
          try {
            const stats = await statfs(process.cwd());
            return stats.bavail * stats.bsize > config.coordination.diskSpaceThreshold;
          } catch {
            return true; // default to allowing spawns on error
          }
        },
        getDispatchQueue: async () => [],
        getActiveClaimRepoKeys: async () => new Map(),
        onMergeAgentCrash: () => {},
        isPaused: () => paused,
        isShuttingDown: () => shuttingDown,
      },
      coordinatorConfig,
    );

    stopCoordinator = coord.start();
  }

  // 4. State tracking
  let paused = false;
  let activeRuns = 0;
  let shuttingDown = false;
  let consecutiveStuckCount = 0;

  /** Shared handler for run outcomes — tracks stuck count and auto-pause. */
  const handleRunOutcome = (outcome: string, issueNumber: number) => {
    if (outcome === 'paused') {
      if (!paused) {
        paused = true;
        console.warn(`[daemon] Auto-paused: daily budget exceeded (issue #${issueNumber})`);
        void notify(config.webhooks, {
          event: 'auto-paused',
          issueNumber,
          phase: 'paused',
          message: 'Daemon auto-paused: daily budget exceeded',
        });
      }
      consecutiveStuckCount = 0;
    } else if (outcome === 'stuck') {
      consecutiveStuckCount++;
      console.log(`[daemon] Consecutive stuck count: ${consecutiveStuckCount}/${config.maxConsecutiveStuck}`);
      if (consecutiveStuckCount >= config.maxConsecutiveStuck && !paused) {
        paused = true;
        console.warn(`[daemon] Auto-paused: ${consecutiveStuckCount} consecutive stuck runs reached threshold`);
        void notify(config.webhooks, {
          event: 'auto-paused',
          issueNumber,
          phase: 'stuck',
          message: `Daemon auto-paused after ${consecutiveStuckCount} consecutive stuck runs`,
        });
      }
    } else {
      consecutiveStuckCount = 0;
    }
  };

  // 5. Build RepoManager or legacy single-repo detector
  let repoManager: RepoManager | null = null;
  let legacyDetector: WorkDetector | null = null;

  if (supabase) {
    // DB mode
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repoManager = new RepoManager(
      supabase as any,
      config.pollIntervalMs,
      async (repoId, owner, name, detector) => {
        if (paused || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        costTracker.maybeResetDaily();
        const claimedIssues = new Set<number>();
        const workResult = await detector.detectReadyWork();
        if (!workResult.ok) {
          // TODO: proactive token health check — if 401, mark connection token_invalid
          return;
        }
        for (const request of workResult.value) {
          if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) break;
          if (paused || shuttingDown) break;
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          claimedIssues.add(request.issueNumber);
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          processWorkRequest(config, repoId, owner, name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
            .then((outcome) => handleRunOutcome(outcome, request.issueNumber))
            .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
            // CRITICAL: notifyRunEnd must be in .finally(), never only in .catch() or .then().
            // If it is missing here, a disabled repo's poller hangs in pendingDisable forever.
            .finally(() => {
              activeRuns--;
              repoManager!.notifyRunEnd(repoId);
            });
        }

        // Bug-fix detection — lower priority than ready work (#284)
        if (paused || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const bugResult = await detector.detectBugFixWork();
        if (bugResult.ok && bugResult.value && !claimedIssues.has(bugResult.value.issueNumber)) {
          const bugRequest = bugResult.value;
          const bugClaimResult = await detector.claimBugFixWork(bugRequest.issueNumber);
          if (bugClaimResult.ok) {
            claimedIssues.add(bugRequest.issueNumber);
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(config, repoId, owner, name, bugRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
              .then((outcome) => handleRunOutcome(outcome, bugRequest.issueNumber))
              .catch((e) => console.error(`Run failed for #${bugRequest.issueNumber}:`, e))
              .finally(() => {
                activeRuns--;
                repoManager!.notifyRunEnd(repoId);
              });
          }
        }

        // Feature-pipeline detection — lowest priority (#282)
        if (paused || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const fpResult = await detector.detectFeaturePipelineWork();
        if (fpResult.ok && fpResult.value && !claimedIssues.has(fpResult.value.issueNumber)) {
          const fpRequest = fpResult.value;
          const fpClaimResult = await detector.claimFeaturePipelineWork(fpRequest.issueNumber, fpRequest.workType as FeaturePipelineWorkType);
          if (fpClaimResult.ok) {
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(config, repoId, owner, name, fpRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
              .then((outcome) => handleRunOutcome(outcome, fpRequest.issueNumber))
              .catch((e) => console.error(`Run failed for #${fpRequest.issueNumber}:`, e))
              .finally(() => {
                activeRuns--;
                repoManager!.notifyRunEnd(repoId);
              });
          }
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
      configReader?.stop();
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
  const envHost = process.env.DAEMON_HOST;
  if (envHost !== undefined && isIP(envHost) !== 4) {
    return err(new Error(`Invalid DAEMON_HOST: "${envHost}" — must be a valid IPv4 address`));
  }
  const daemonHost = envHost ?? config.controlHost;
  const { server, start } = createControlServer(config.controlPort, {
    getStatus: () => {
      const { remote_control_url: _, ...safeState } = remoteControl.getState() ?? {};
      return {
        activeRuns,
        dailyCost: costTracker.getDailyCost(),
        paused,
        consecutiveStuckCount,
        uptime: process.uptime(),
        ...safeState,
      };
    },
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    retry: (_issueNumber) => err(new Error('retry not yet implemented')),
    reloadRepos: repoManager
      ? async () => repoManager!.reload()
      : undefined,
    restartRemoteControl: async () => { await remoteControl.restart(); },
    scanIssues: repoManager
      ? async () => repoManager!.scanNow()
      : undefined,
    submitIdea: async (submittedBy, description) => {
      const idea = await poAgent.submitIdea(submittedBy, description);
      return { id: idea.id };
    },
  }, daemonHost);
  const serverResult = await start();
  if (!serverResult.ok) {
    repoManager?.stop();
    configReader?.stop();
    await remoteControl.stop();
    return serverResult;
  }

  console.log(`Auto-Claude daemon started on ${daemonHost}:${config.controlPort}`);

  // 6b. Crash resumption — resume incomplete runs from prior crash
  const incompleteRuns = await stateMgr.findIncompleteRuns();
  for (const run of incompleteRuns) {
    const runOwner = run.repoOwner ?? config.repo?.owner;
    const runRepoName = run.repoName ?? config.repo?.name;
    if (!runOwner || !runRepoName) {
      console.warn(`[daemon] Skipping incomplete run #${run.issueNumber} — missing repo info`);
      continue;
    }
    console.log(`[daemon] Resuming incomplete run #${run.issueNumber} from phase '${run.phase}'`);
    activeRuns++;

    // Look up repoId for DB-mode repo tracking
    const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
    if (repoManager && resumeRepoId) {
      repoManager.notifyRunStart(resumeRepoId);
    }

    const resumeToken = repoManager && resumeRepoId
      ? await repoManager.resolveTokenForRepo(resumeRepoId)
      : process.env.GITHUB_TOKEN;
    const notifyOctokit = new Octokit({ auth: resumeToken });
    const agencyConfig = await readAgencyConfig(null, '');
    const resumedRequest: WorkRequest = {
      issueNumber: run.issueNumber,
      title: run.title,
      body: run.body ?? '',
      labels: run.labels ?? [],
      specRefs: run.specRefs ?? [],
    };
    const handlers = run.variant === 'website'
      ? createWebsitePhaseHandlers(agencyConfig, null, notifyOctokit, runOwner, runRepoName, run.issueNumber, null)
      : createPhaseHandlers(config, runOwner, runRepoName, runtime, coordinator, notifyOctokit, resumedRequest, stateDir, runWriter ?? undefined, run.id, repoRoot, configReader?.getRepoConfig(runOwner, runRepoName)?.activePlugins, knowledgeStore);
    const table = getPipeline(run.variant);

    const resumeDetector = legacyDetector ?? createWorkDetector(new Octokit({ auth: resumeToken }), runOwner, runRepoName);
    runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined)
      .then(async (result) => {
        console.log(`[daemon] Resumed run #${run.issueNumber} finished: ${result.outcome}`);

        void runWriter?.upsertRun(run.id, {
          outcome: toDbOutcome(result.outcome),
          completed_at: new Date().toISOString(),
          total_cost: run.cost,
        });

        handleRunOutcome(result.outcome, run.issueNumber);

        if (result.outcome === 'stuck') {
          await resumeDetector.markStuck(run.issueNumber, result.error ?? 'Unknown error');
          await notify(config.webhooks, {
            event: 'stuck',
            issueNumber: run.issueNumber,
            phase: run.phase,
            message: `Issue #${run.issueNumber} stuck: ${result.error ?? 'unknown'}`,
          });
        }
      })
      .catch((e) => console.error(`Resumed run failed for #${run.issueNumber}:`, e))
      .finally(() => {
        activeRuns--;
        if (repoManager && resumeRepoId) {
          repoManager.notifyRunEnd(resumeRepoId);
        }
      });
  }

  // 7. Legacy polling loop (only used when repoManager is null AND coordinator is off)
  let legacyPoller: ReturnType<typeof setInterval> | null = null;
  if (legacyDetector && !config.coordination.useCoordinator) {
    const detector = legacyDetector;
    legacyPoller = setInterval(async () => {
      if (paused || shuttingDown) return;
      if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
      costTracker.maybeResetDaily();
      const claimedIssues = new Set<number>();
      const workResult = await detector.detectReadyWork();
      if (!workResult.ok) return;
      for (const request of workResult.value) {
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) break;
        if (paused || shuttingDown) break;
        const claimResult = await detector.claimWork(request.issueNumber);
        if (!claimResult.ok) continue;
        claimedIssues.add(request.issueNumber);
        activeRuns++;
        processWorkRequest(config, '', config.repo!.owner, config.repo!.name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
          .then((outcome) => handleRunOutcome(outcome, request.issueNumber))
          .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
          .finally(() => { activeRuns--; });
      }

      // Bug-fix detection — lower priority than ready work (#284)
      if (paused || shuttingDown) return;
      if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
      const bugResult = await detector.detectBugFixWork();
      if (bugResult.ok && bugResult.value && !claimedIssues.has(bugResult.value.issueNumber)) {
        const bugRequest = bugResult.value;
        const bugClaimResult = await detector.claimBugFixWork(bugRequest.issueNumber);
        if (bugClaimResult.ok) {
          claimedIssues.add(bugRequest.issueNumber);
          activeRuns++;
          processWorkRequest(config, '', config.repo!.owner, config.repo!.name, bugRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
            .then((outcome) => handleRunOutcome(outcome, bugRequest.issueNumber))
            .catch((e) => console.error(`Run failed for #${bugRequest.issueNumber}:`, e))
            .finally(() => { activeRuns--; });
        }
      }

      // Feature-pipeline detection — lowest priority (#282)
      if (paused || shuttingDown) return;
      if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
      const fpResult = await detector.detectFeaturePipelineWork();
      if (fpResult.ok && fpResult.value && !claimedIssues.has(fpResult.value.issueNumber)) {
        const fpRequest = fpResult.value;
        const fpClaimResult = await detector.claimFeaturePipelineWork(fpRequest.issueNumber, fpRequest.workType as FeaturePipelineWorkType);
        if (fpClaimResult.ok) {
          activeRuns++;
          processWorkRequest(config, '', config.repo!.owner, config.repo!.name, fpRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
            .then((outcome) => handleRunOutcome(outcome, fpRequest.issueNumber))
            .catch((e) => console.error(`Run failed for #${fpRequest.issueNumber}:`, e))
            .finally(() => { activeRuns--; });
        }
      }
    }, config.pollIntervalMs);
  }

  // 8. Graceful shutdown
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    if (legacyPoller) clearInterval(legacyPoller);
    if (stopCoordinator) stopCoordinator();
    stopReviewScheduler();
    stopPOAgent?.();
    stopTechLeadScheduler?.();
    repoManager?.stop();
    configReader?.stop();
    const deadline = Date.now() + config.gracePeriodMs;
    while (activeRuns > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await remoteControl.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('[daemon] Instance lock released');
    console.log('Daemon stopped.');
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return ok(undefined);
}

async function processWorkRequest(
  config: Config,
  repoId: string,
  owner: string,
  repoName: string,
  request: WorkRequest,
  runtime: SessionRuntime,
  coordinator: ImplementationCoordinator,
  costTracker: CostTracker,
  stateMgr: StateManager,
  detector: WorkDetector,
  stateDir: string,
  runWriter?: SupabaseRunWriter,
  configReader?: SupabaseConfigReader,
  repoRoot?: string,
  knowledgeStore?: KnowledgeStore,
  repoManager?: RepoManager | null,
): Promise<string> {
  const repoConfig = configReader?.getRepoConfig(owner, repoName);
  const variant = selectVariant(request);
  const run: RunState = {
    id: crypto.randomUUID(),
    issueNumber: request.issueNumber,
    title: request.title,
    phase: getStartPhase(variant),
    variant,
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: repoConfig?.budgetLimit ?? config.perRunBudget,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: owner,
    repoName: repoName,
    body: request.body,
    labels: request.labels,
    specRefs: request.specRefs,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await stateMgr.saveRunState(run);

  await runWriter?.upsertRun(run.id, {
    repo_id: repoId || null,
    repo_owner: owner,
    repo_name: repoName,
    issue_number: request.issueNumber,
    issue_title: request.title,
    pipeline_variant: run.variant,
    outcome: 'in-progress',
    started_at: run.startedAt,
    active_plugins: repoConfig?.activePlugins.map(p => p.id) ?? [],
  });

  // Build a notifyOctokit using per-connection token when available
  const resolvedToken = repoManager ? await repoManager.resolveTokenForRepo(repoId) : process.env.GITHUB_TOKEN;
  const notifyOctokit = new Octokit({ auth: resolvedToken });
  const agencyConfig = await readAgencyConfig(null, '');
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
    : createPhaseHandlers(config, owner, repoName, runtime, coordinator, notifyOctokit, request, stateDir, runWriter ?? undefined, run.id, repoRoot, repoConfig?.activePlugins, knowledgeStore);
  const table = getPipeline(variant);

  console.log(`[daemon] Pipeline start for #${request.issueNumber}: ${request.title}`);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined);
  console.log(`[daemon] Pipeline done for #${request.issueNumber}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);

  void runWriter?.upsertRun(run.id, {
    outcome: toDbOutcome(result.outcome),
    completed_at: new Date().toISOString(),
    report: run.report ?? null,
    total_cost: run.cost,
    fix_attempts: run.fixAttempts.length,
    active_plugins: repoConfig?.activePlugins.map(p => p.id) ?? [],
  });

  if (result.outcome === 'stuck') {
    await detector.markStuck(request.issueNumber, result.error ?? 'Unknown error');
    await notify(config.webhooks, {
      event: 'stuck',
      issueNumber: request.issueNumber,
      phase: run.phase,
      message: `Issue #${request.issueNumber} stuck: ${result.error ?? 'unknown'}`,
    });
  }

  return result.outcome;
}
