// src/control-plane/daemon.ts
import { isIP } from 'node:net';
import { Octokit } from '@octokit/rest';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import { createReleaseProposal } from './release.js';
import { RepoManager } from './repo-manager.js';
import { createWorkDetector, type WorkDetector, type FeaturePipelineWorkType } from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import { createWebsitePhaseHandlers } from './phases-website.js';
import { readAgencyConfig } from './agency-config.js';
import { runPipeline } from './pipeline.js';
import { createPhaseLabelMirror } from './phase-labels.js';
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
import { validatePromptContracts } from '../knowledge/prompt-contracts.js';
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
import { startHeartbeat } from './heartbeat.js';
import { createKnowledgeSyncService } from '../knowledge-sync/sync-service.js';
import { TechProposalStore } from '../coordination/tech-lead/proposal-store.js';
import { assembleSignalDigest } from '../coordination/tech-lead/signal-digest.js';
import { isTerminalStatus } from '../coordination/tech-lead/proposal-lifecycle.js';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import { mkdir } from 'fs/promises';
import type { Proposal, IdeaSubmission } from '../coordination/types.js';
import { buildProductOwnerSessionVariables, PRODUCT_OWNER_SNAPSHOT_CONFIG } from './po-snapshot.js';

let dailyRunCount = 0;
let dailyRunCountResetDate = new Date().toISOString().split('T')[0];

export async function startDaemon(configPath: string): Promise<Result<void>> {
  // 0. Validate GITHUB_TOKEN — required for Octokit (labeling, commenting, notifications)
  if (!process.env.GITHUB_TOKEN) {
    return err(new Error(
      'GITHUB_TOKEN environment variable is not set. The daemon requires a GitHub token to interact with issues and pull requests.',
    ));
  }

  // 0b. Validate prompt contracts — refuse to boot if any registered prompt has drifted
  // from its declared contract. Production gate against drift introduced by prompt-optimizer
  // proposals or operator edits — neither of which CI can see.
  const promptsDirPath = process.env['PROMPTS_DIR'] ?? join(import.meta.dirname, '../../../../prompts');
  const contractCheck = await validatePromptContracts(promptsDirPath);
  if (!contractCheck.ok) {
    console.error(`[daemon] Prompt contract validation failed:\n${contractCheck.error.message}`);
    return err(contractCheck.error);
  }
  console.log(`[daemon] Prompt contracts validated (${contractCheck.value.checked} prompts)`);

  // 0c. Pre-warm the prompt template cache while HEAD is still on the daemon's
  // startup branch (typically `dev`). Pipeline phases like coordinator.implement
  // and integrateToStaging move HEAD in mainRepoRoot during normal operation,
  // and prompts/*.md is read from that working copy. Without pre-warming, the
  // first session that loads a prompt mid-pipeline can cache a stale version
  // from the feature branch the daemon happens to be checked out to at that
  // moment. Pre-warming freezes a known-good revision for the daemon's lifetime.
  const { preloadPromptCache } = await import('../session-runtime/runtime.js');
  const preloaded = await preloadPromptCache();
  console.log(`[daemon] Prompt cache pre-warmed (${preloaded} prompts)`);

  // 1. Load config
  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  const { preloadGovernanceContext } = await import('../session-runtime/governance-context.js');
  try {
    const governance = await preloadGovernanceContext(config, process.cwd());
    console.log(`[daemon] Governance context loaded from ${governance.sourcePath}`);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

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

    // Mark orphaned in-progress runs as stuck (from previous daemon crash/restart)
    const { data: orphaned, error: orphanErr } = await supabase
      .from('runs')
      .update({ outcome: 'stuck', completed_at: new Date().toISOString() })
      .eq('outcome', 'in-progress')
      .select('id');
    if (orphanErr) {
      console.warn('[daemon] Failed to clean orphaned runs:', orphanErr.message);
    } else if (orphaned && orphaned.length > 0) {
      console.log(`[daemon] Marked ${orphaned.length} orphaned in-progress runs as stuck`);
    }
  }

  // 3. Initialize services
  const costTracker = new CostTracker({
    dailyBudget: configReader?.getGlobalConfig()?.dailyBudgetLimit ?? config.dailyBudget,
    perRunBudget: config.perRunBudget, // per-run budget is repo-specific, handled per-run
  });
  const runtime = new SessionRuntime(config, costTracker);
  const gotchasPath = join(stateDir, 'gotchas.jsonl');
  const gotchaStore = new GotchaStore(gotchasPath);
  const knowledgeStore = new KnowledgeStore(join(stateDir, 'knowledge.jsonl'), DEFAULT_POLICIES, gotchasPath);
  const repoRoot = process.cwd();
  // maxDiffLines: 2000 — real features (multi-file specs, e.g., knowledge-sync, multi-provider)
  // routinely produce 500–1500 line diffs. The historical 300 ceiling silently failed any
  // substantive feature implementation. Review gates remain the safety net for bad large diffs.
  const coordinator = new ImplementationCoordinator(runtime, repoRoot, 2000, 2000, gotchaStore, knowledgeStore);

  // 3b. Start Knowledge Sync schedule (opt-in; no-op when knowledgeSync.enabled is false)
  let knowledgeSyncPoller: ReturnType<typeof setInterval> | null = null;
  if (config.knowledgeSync?.enabled) {
    const syncService = createKnowledgeSyncService(config.knowledgeSync, knowledgeStore, stateDir);
    const intervalMs = config.knowledgeSync.syncIntervalMinutes * 60_000;
    knowledgeSyncPoller = setInterval(() => {
      syncService.triggerSync().catch(e => console.warn('[knowledge-sync] cycle error:', e));
    }, intervalMs);
    // Trigger an initial cycle on startup
    syncService.triggerSync().catch(e => console.warn('[knowledge-sync] startup cycle error:', e));
  }

  // 3c. Start Remote Control
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
        // Parse structured data from session output — codebase-reviewer.md outputs
        // { findings: [...], candidatesFound, candidatesDropped, ... }
        const data = result.value.structuredData as {
          findings?: unknown[];
          candidatesFound?: number;
        } | null;
        return {
          findingsCount: data?.findings?.length ?? 0,
          // The reviewer is read-only; issue creation happens downstream
          issuesCreated: 0,
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
  const poSnapshotGithub = config.repo
    ? {
      owner: config.repo.owner,
      repo: config.repo.name,
      issues: new Octokit({ auth: process.env.GITHUB_TOKEN }).issues,
    }
    : undefined;
  const poSnapshotConfig = {
    ...PRODUCT_OWNER_SNAPSHOT_CONFIG,
    maxFindingsEntries: config.coordination.poFindingDailyCap,
  };
  const loadPOProposals = async () => {
    const result = await readJsonSafe<Proposal[]>(proposalsPath);
    return result.ok ? result.value : [];
  };
  const savePOProposals = async (proposals: Proposal[]) => {
    await writeJsonSafe(proposalsPath, proposals);
  };
  const loadPOIdeas = async () => {
    const result = await readJsonSafe<IdeaSubmission[]>(ideasPath);
    return result.ok ? result.value : [];
  };
  const savePOIdeas = async (ideas: IdeaSubmission[]) => {
    await writeJsonSafe(ideasPath, ideas);
  };

  const poAgent = createPOAgent(
    {
      loadProposals: loadPOProposals,
      saveProposals: savePOProposals,
      loadIdeas: loadPOIdeas,
      saveIdeas: savePOIdeas,
      spawnPOSession: async () => {
        const variables = await buildProductOwnerSessionVariables({
          repoRoot,
          stateDir,
          loadProposals: loadPOProposals,
          loadIdeas: loadPOIdeas,
          github: poSnapshotGithub,
        }, poSnapshotConfig);
        const result = await runtime.spawnSession(
          'product-owner',
          { variables },
          0,
        );
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
        return result.value.output;
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
      maxConsecutiveTickErrors: config.coordination.maxConsecutiveTickErrors,
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
        onTickErrorThresholdReached: (consecutiveErrors, lastError) => {
          if (!paused) {
            paused = true;
            console.warn(`[daemon] Auto-paused: coordinator hit ${consecutiveErrors} consecutive tick errors`);
            void notify(config.webhooks, {
              event: 'auto-paused',
              issueNumber: 0,
              phase: 'tick-error',
              message: `Daemon auto-paused after ${consecutiveErrors} consecutive coordinator tick errors: ${lastError}`,
            });
          }
        },
      },
      coordinatorConfig,
    );

    stopCoordinator = coord.start();
  }

  // 4. State tracking
  let paused = false;
  let draining = false;
  let activeRuns = 0;
  let shuttingDown = false;
  let consecutiveStuckCount = 0;
  const activeIssues = new Set<number>(); // Persists across poll cycles — prevents duplicate runs

  const stuckBackoff = new Map<string, { count: number; lastStuckAt: number }>();
  function issueKey(owner: string, repo: string, issue: number): string {
    return `${owner}/${repo}#${issue}`;
  }
  function isBackedOff(key: string, cfg: Config): boolean {
    const entry = stuckBackoff.get(key);
    if (!entry) return false;
    const backoff = Math.min(cfg.retryBackoffBaseMs * Math.pow(2, entry.count - 1), cfg.retryBackoffMaxMs);
    return Date.now() - entry.lastStuckAt < backoff;
  }

  /** Shared handler for run outcomes — tracks stuck count and auto-pause. */
  const handleRunOutcome = (outcome: string, issueNumber: number, owner?: string, repo?: string) => {
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
      if (owner && repo) {
        const key = issueKey(owner, repo, issueNumber);
        const prev = stuckBackoff.get(key);
        stuckBackoff.set(key, { count: (prev?.count ?? 0) + 1, lastStuckAt: Date.now() });
      }
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
    } else if (outcome === 'parked') {
      // Gate-parked run — no-op, don't increment stuck or pause daemon
      console.log(`[daemon] Run #${issueNumber} parked at gate, awaiting approval`);
    } else {
      // Success or other non-error outcome — clear backoff for this issue
      if (owner && repo) {
        stuckBackoff.delete(issueKey(owner, repo, issueNumber));
      }
      consecutiveStuckCount = 0;
    }

    // Drain mode: exit once all active runs finish
    if (draining && activeRuns === 0) {
      console.log('[daemon] Drain complete — all runs finished, shutting down');
      void shutdown();
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
        if (paused || draining || shuttingDown) return;
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
          if (paused || draining || shuttingDown) break;
          if (activeIssues.has(request.issueNumber)) continue; // Already running
          if (isBackedOff(issueKey(owner, name, request.issueNumber), config)) {
            console.log(`[daemon] Issue #${request.issueNumber} is in backoff — skipping`);
            continue;
          }
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          claimedIssues.add(request.issueNumber);
          activeIssues.add(request.issueNumber);
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          processWorkRequest(config, repoId, owner, name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
            .then((outcome) => handleRunOutcome(outcome, request.issueNumber, owner, name))
            .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
            .finally(() => {
              activeRuns--;
              activeIssues.delete(request.issueNumber);
              repoManager!.notifyRunEnd(repoId);
            });
        }

        // Bug-fix detection — lower priority than ready work (#284)
        if (paused || draining || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const bugResult = await detector.detectBugFixWork();
        if (bugResult.ok && bugResult.value && !claimedIssues.has(bugResult.value.issueNumber) && !activeIssues.has(bugResult.value.issueNumber)) {
          const bugRequest = bugResult.value;
          const bugClaimResult = await detector.claimBugFixWork(bugRequest.issueNumber);
          if (bugClaimResult.ok) {
            claimedIssues.add(bugRequest.issueNumber);
            activeIssues.add(bugRequest.issueNumber);
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(config, repoId, owner, name, bugRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
              .then((outcome) => handleRunOutcome(outcome, bugRequest.issueNumber, owner, name))
              .catch((e) => console.error(`Run failed for #${bugRequest.issueNumber}:`, e))
              .finally(() => {
                activeRuns--;
                activeIssues.delete(bugRequest.issueNumber);
                repoManager!.notifyRunEnd(repoId);
              });
          }
        }

        // Feature-pipeline detection — lowest priority (#282)
        if (paused || draining || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const fpResult = await detector.detectFeaturePipelineWork();
        if (fpResult.ok && fpResult.value && !claimedIssues.has(fpResult.value.issueNumber) && !activeIssues.has(fpResult.value.issueNumber)) {
          const fpRequest = fpResult.value;
          const fpClaimResult = await detector.claimFeaturePipelineWork(fpRequest.issueNumber, fpRequest.workType as FeaturePipelineWorkType);
          if (fpClaimResult.ok) {
            activeIssues.add(fpRequest.issueNumber);
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(config, repoId, owner, name, fpRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, runWriter ?? undefined, configReader ?? undefined, repoRoot, knowledgeStore, repoManager)
              .then((outcome) => handleRunOutcome(outcome, fpRequest.issueNumber, owner, name))
              .catch((e) => console.error(`Run failed for #${fpRequest.issueNumber}:`, e))
              .finally(() => {
                activeRuns--;
                activeIssues.delete(fpRequest.issueNumber);
                repoManager!.notifyRunEnd(repoId);
              });
          }
        }

        // Parked-run resume scan — after all normal work detection (mirrors legacy poller)
        await resumeParkedRuns().catch((e) => console.error('[daemon] resumeParkedRuns error:', e));
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
    void createPhaseLabelMirror(legacyOctokit, config.repo.owner, config.repo.name).provisionLabels();
  }

  // 6. Start control server
  const envHost = process.env.DAEMON_HOST;
  const daemonHost = envHost ?? config.controlHost;
  const daemonHostSource = envHost !== undefined ? 'DAEMON_HOST' : 'controlHost';
  if (isIP(daemonHost) !== 4) {
    return err(new Error(`Invalid ${daemonHostSource}: "${daemonHost}" — must be a valid IPv4 address`));
  }
  const { server, start } = createControlServer(config.controlPort, {
    getStatus: () => {
      const { remote_control_url: _, ...safeState } = remoteControl.getState() ?? {};
      return {
        activeRuns,
        activeIssues: [...activeIssues],
        dailyRunCount,
        dailyCost: costTracker.getDailyCost(),
        paused,
        draining,
        consecutiveStuckCount,
        uptime: process.uptime(),
        ...safeState,
      };
    },
    pause: () => { paused = true; },
    resume: () => { paused = false; draining = false; },
    drain: () => { enterDrainMode(); },
    cancelDrain: () => {
      if (draining && !shuttingDown) {
        draining = false;
        console.log('[daemon] Drain cancelled — resuming normal operation');
      }
    },
    retry: (_issueNumber) => err(new Error('retry not yet implemented')),
    reloadRepos: repoManager
      ? async () => repoManager!.reload()
      : undefined,
    restartRemoteControl: async () => { await remoteControl.restart(); },
    scanIssues: repoManager
      ? async () => repoManager!.scanNow()
      : undefined,
    release: config.repo
      ? async () => createReleaseProposal(
          new Octokit({ auth: process.env.GITHUB_TOKEN }),
          config.repo!.owner,
          config.repo!.name,
          config.branches.staging,
          config.branches.production,
          stateDir,
        )
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
    activeIssues.add(run.issueNumber);
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
    const phaseLabelMirror = createPhaseLabelMirror(notifyOctokit, runOwner, runRepoName);
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
      : createPhaseHandlers(config, runOwner, runRepoName, runtime, coordinator, notifyOctokit, resumedRequest, stateDir, runWriter ?? undefined, run.id, repoRoot, configReader?.getRepoConfig(runOwner, runRepoName)?.activePlugins, knowledgeStore, phaseLabelMirror);
    const table = getPipeline(run.variant);

    const resumeDetector = legacyDetector ?? createWorkDetector(new Octokit({ auth: resumeToken }), runOwner, runRepoName);
    runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined, phaseLabelMirror)
      .then(async (result) => {
        console.log(`[daemon] Resumed run #${run.issueNumber} finished: ${result.outcome}`);

        void runWriter?.upsertRun(run.id, {
          outcome: toDbOutcome(result.outcome),
          completed_at: new Date().toISOString(),
          total_cost: run.cost,
        });

        handleRunOutcome(result.outcome, run.issueNumber, runOwner, runRepoName);

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
        activeIssues.delete(run.issueNumber);
        if (repoManager && resumeRepoId) {
          repoManager.notifyRunEnd(resumeRepoId);
        }
      });
  }

  // 6c. Heartbeat — write a timestamp file for operator monitoring (health.sh compatibility)
  const heartbeatPath = join(process.env.HOME ?? '/tmp', 'logs', 'claude-daemon.heartbeat');
  const stopHeartbeat = startHeartbeat(heartbeatPath, config.pollIntervalMs);

  // 6d. resumeParkedRuns — check parked runs for l2-approved/l2-rejected label, re-enter pipeline
  async function resumeParkedRuns(): Promise<void> {
    if (paused || draining || shuttingDown) return;
    const parkedRuns = await stateMgr.findParkedRuns();
    // Limit to 1 resume per cycle to avoid thundering-herd
    for (const run of parkedRuns.slice(0, 1)) {
      if (activeIssues.has(run.issueNumber)) continue; // already running
      const runOwner = run.repoOwner ?? config.repo?.owner;
      const runRepoName = run.repoName ?? config.repo?.name;
      if (!runOwner || !runRepoName) {
        console.warn(`[daemon] resumeParkedRuns: skipping run #${run.issueNumber} — missing repo info`);
        continue;
      }
      if (run.pausedAtPhase !== 'l2-gate') {
        // Only l2-gate parking is handled here; other parks are not yet defined
        continue;
      }

      // Resolve token and Octokit once for all operations on this run
      const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
      const resumeToken = repoManager && resumeRepoId
        ? await repoManager.resolveTokenForRepo(resumeRepoId)
        : process.env.GITHUB_TOKEN;
      const runOctokit = new Octokit({ auth: resumeToken });
      const phaseLabelMirror = createPhaseLabelMirror(runOctokit, runOwner, runRepoName);

      // Fetch current labels from GitHub
      let issueLabels: string[];
      try {
        const { data: issue } = await runOctokit.issues.get({
          owner: runOwner, repo: runRepoName, issue_number: run.issueNumber,
        });
        issueLabels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
      } catch (e) {
        console.warn(`[daemon] resumeParkedRuns: failed to fetch labels for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const hasApproved = issueLabels.includes('l2-approved');
      const hasRejected = issueLabels.includes('l2-rejected');
      if (!hasApproved && !hasRejected) continue; // still waiting

      console.log(`[daemon] resumeParkedRuns: resuming #${run.issueNumber} (${hasApproved ? 'l2-approved' : 'l2-rejected'})`);

      // Remove gate labels (best-effort) — both awaiting and rejected must be cleared
      // to prevent the l2-gate handler from immediately seeing l2-rejected on resume
      for (const label of ['awaiting-l2-review', 'l2-rejected']) {
        try {
          await runOctokit.issues.removeLabel({
            owner: runOwner, repo: runRepoName, issue_number: run.issueNumber,
            name: label,
          });
        } catch { /* label may not exist — ignore */ }
      }

      // Reset run state to re-enter l2-gate phase
      run.phase = 'l2-gate';
      run.pausedAtPhase = undefined;
      await stateMgr.saveRunState(run);

      // Re-enter pipeline
      activeIssues.add(run.issueNumber);
      activeRuns++;
      if (repoManager && resumeRepoId) repoManager.notifyRunStart(resumeRepoId);

      const notifyOctokit = runOctokit;
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
        : createPhaseHandlers(config, runOwner, runRepoName, runtime, coordinator, notifyOctokit, resumedRequest, stateDir, runWriter ?? undefined, run.id, repoRoot, configReader?.getRepoConfig(runOwner, runRepoName)?.activePlugins, knowledgeStore, phaseLabelMirror);
      const table = getPipeline(run.variant);

      runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined, phaseLabelMirror)
        .then(async (result) => {
          console.log(`[daemon] Parked run #${run.issueNumber} finished: ${result.outcome}`);
          void runWriter?.upsertRun(run.id, {
            outcome: toDbOutcome(result.outcome),
            completed_at: new Date().toISOString(),
            total_cost: run.cost,
          });
          if (result.outcome === 'stuck') {
            const stuckDetector = legacyDetector ?? createWorkDetector(runOctokit, runOwner, runRepoName);
            await stuckDetector.markStuck(run.issueNumber, result.error ?? 'Unknown error');
          }
          handleRunOutcome(result.outcome, run.issueNumber, runOwner, runRepoName);
        })
        .catch((e) => console.error(`Parked run failed for #${run.issueNumber}:`, e))
        .finally(() => {
          activeRuns--;
          activeIssues.delete(run.issueNumber);
          if (repoManager && resumeRepoId) repoManager.notifyRunEnd(resumeRepoId);
        });
    }
  }

  // 7. Legacy polling loop (only used when repoManager is null AND coordinator is off)
  let legacyPoller: ReturnType<typeof setInterval> | null = null;
  let legacyPollInProgress = false;
  if (legacyDetector && !config.coordination.useCoordinator) {
    const detector = legacyDetector;
    legacyPoller = setInterval(async () => {
      if (legacyPollInProgress) return;
      legacyPollInProgress = true;
      try {
        if (paused || draining || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        costTracker.maybeResetDaily();
        const claimedIssues = new Set<number>();
        const workResult = await detector.detectReadyWork();
        if (!workResult.ok) return;
        for (const request of workResult.value) {
          if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) break;
          if (paused || draining || shuttingDown) break;
          if (activeIssues.has(request.issueNumber)) continue;
          if (isBackedOff(issueKey(config.repo!.owner, config.repo!.name, request.issueNumber), config)) {
            console.log(`[daemon] Issue #${request.issueNumber} is in backoff — skipping`);
            continue;
          }
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          claimedIssues.add(request.issueNumber);
          activeIssues.add(request.issueNumber);
          activeRuns++;
          processWorkRequest(config, '', config.repo!.owner, config.repo!.name, request, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
            .then((outcome) => handleRunOutcome(outcome, request.issueNumber, config.repo!.owner, config.repo!.name))
            .catch((e) => console.error(`Run failed for #${request.issueNumber}:`, e))
            .finally(() => { activeRuns--; activeIssues.delete(request.issueNumber); });
        }

        // Bug-fix detection — lower priority than ready work (#284)
        if (paused || draining || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const bugResult = await detector.detectBugFixWork();
        if (bugResult.ok && bugResult.value && !claimedIssues.has(bugResult.value.issueNumber) && !activeIssues.has(bugResult.value.issueNumber)) {
          const bugRequest = bugResult.value;
          const bugClaimResult = await detector.claimBugFixWork(bugRequest.issueNumber);
          if (bugClaimResult.ok) {
            claimedIssues.add(bugRequest.issueNumber);
            activeIssues.add(bugRequest.issueNumber);
            activeRuns++;
            processWorkRequest(config, '', config.repo!.owner, config.repo!.name, bugRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
              .then((outcome) => handleRunOutcome(outcome, bugRequest.issueNumber, config.repo!.owner, config.repo!.name))
              .catch((e) => console.error(`Run failed for #${bugRequest.issueNumber}:`, e))
              .finally(() => { activeRuns--; activeIssues.delete(bugRequest.issueNumber); });
          }
        }

        // Feature-pipeline detection — lowest priority (#282)
        if (paused || draining || shuttingDown) return;
        if (activeRuns >= (configReader?.getGlobalConfig()?.concurrencyLimit ?? config.maxConcurrentRuns)) return;
        const fpResult = await detector.detectFeaturePipelineWork();
        if (fpResult.ok && fpResult.value && !claimedIssues.has(fpResult.value.issueNumber) && !activeIssues.has(fpResult.value.issueNumber)) {
          const fpRequest = fpResult.value;
          const fpClaimResult = await detector.claimFeaturePipelineWork(fpRequest.issueNumber, fpRequest.workType as FeaturePipelineWorkType);
          if (fpClaimResult.ok) {
            activeIssues.add(fpRequest.issueNumber);
            activeRuns++;
            processWorkRequest(config, '', config.repo!.owner, config.repo!.name, fpRequest, runtime, coordinator, costTracker, stateMgr, detector, stateDir, undefined, undefined, repoRoot, knowledgeStore)
              .then((outcome) => handleRunOutcome(outcome, fpRequest.issueNumber, config.repo!.owner, config.repo!.name))
              .catch((e) => console.error(`Run failed for #${fpRequest.issueNumber}:`, e))
              .finally(() => { activeRuns--; activeIssues.delete(fpRequest.issueNumber); });
          }
        }

        // Parked-run resume scan — after all normal work detection
        await resumeParkedRuns().catch((e) => console.error('[daemon] resumeParkedRuns error:', e));
      } finally {
        legacyPollInProgress = false;
      }
    }, config.pollIntervalMs);
  }

  // 8. Drain mode + graceful shutdown
  const enterDrainMode = async () => {
    if (draining) return;
    draining = true;
    console.log(`[daemon] Entering drain mode — ${activeRuns} active run(s), waiting for completion`);
    // Stop schedulers so no new background work starts
    if (legacyPoller) clearInterval(legacyPoller);
    if (knowledgeSyncPoller) clearInterval(knowledgeSyncPoller);
    stopReviewScheduler();
    stopPOAgent?.();
    stopTechLeadScheduler?.();
    repoManager?.stop();
    // If no active runs, shut down immediately
    if (activeRuns === 0) {
      console.log('[daemon] No active runs — shutting down immediately');
      await shutdown();
    }
    // Otherwise, handleRunOutcome will call shutdown() when activeRuns hits 0
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    if (legacyPoller) clearInterval(legacyPoller);
    if (knowledgeSyncPoller) clearInterval(knowledgeSyncPoller);
    stopHeartbeat();
    if (stopCoordinator) stopCoordinator();
    stopReviewScheduler();
    stopPOAgent?.();
    stopTechLeadScheduler?.();
    repoManager?.stop();
    configReader?.stop();
    await remoteControl.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('[daemon] Instance lock released');
    console.log('Daemon stopped.');
  };

  // SIGTERM/SIGINT enter drain mode — wait for active runs to finish, then exit.
  // Use kill -9 (SIGKILL) for immediate force-kill.
  process.on('SIGTERM', enterDrainMode);
  process.on('SIGINT', enterDrainMode);

  return ok(undefined);
}

async function releaseClaim(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<void> {
  const claimLabels = ['in-progress', 'implementing', 'l2-in-progress', 'l3-in-progress', 'l3-review'];
  for (const label of claimLabels) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
    } catch { /* label may not exist */ }
  }
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
  const today = new Date().toISOString().split('T')[0];
  if (today !== dailyRunCountResetDate) {
    dailyRunCount = 0;
    dailyRunCountResetDate = today;
  }
  dailyRunCount++;
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

  await runWriter?.insertRun(run.id, {
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

  // Per-issue retry cap (DB mode only) — auto-block issues that have gone stuck too many times
  if (runWriter) {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { count } = await supabase
        .from('runs')
        .select('*', { count: 'exact', head: true })
        .eq('issue_number', request.issueNumber)
        .eq('repo_owner', owner)
        .eq('repo_name', repoName)
        .eq('outcome', 'stuck');
      if ((count ?? 0) >= config.maxRunsPerIssue) {
        console.warn(`[daemon] Issue #${request.issueNumber} hit retry cap (${count} stuck runs) — auto-blocking`);
        const capOctokit = new Octokit({ auth: repoManager ? await repoManager.resolveTokenForRepo(repoId) : process.env.GITHUB_TOKEN });
        await capOctokit.issues.addLabels({ owner, repo: repoName, issue_number: request.issueNumber, labels: ['blocked'] });
        await capOctokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: request.issueNumber,
          body: `**Auto-blocked:** this issue went stuck ${count} times. Needs human investigation.`,
        });
        await releaseClaim(capOctokit, owner, repoName, request.issueNumber);
        // Finalize the in-progress DB row so it doesn't become orphaned
        void runWriter?.upsertRun(run.id, {
          outcome: 'stuck',
          completed_at: new Date().toISOString(),
        });
        return 'blocked';
      }
    }
  }

  // Build a notifyOctokit using per-connection token when available
  const resolvedToken = repoManager ? await repoManager.resolveTokenForRepo(repoId) : process.env.GITHUB_TOKEN;
  const notifyOctokit = new Octokit({ auth: resolvedToken });
  const phaseLabelMirror = createPhaseLabelMirror(notifyOctokit, owner, repoName);
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
    : createPhaseHandlers(config, owner, repoName, runtime, coordinator, notifyOctokit, request, stateDir, runWriter ?? undefined, run.id, repoRoot, repoConfig?.activePlugins, knowledgeStore, phaseLabelMirror);
  const table = getPipeline(variant);

  console.log(`[daemon] Pipeline start for #${request.issueNumber}: ${request.title}`);
  const result = await runPipeline(run, table, handlers, stateMgr, costTracker, undefined, runWriter ?? undefined, phaseLabelMirror);
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
