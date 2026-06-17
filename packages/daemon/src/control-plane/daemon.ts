// src/control-plane/daemon.ts
import { isIP } from 'node:net';
import { Octokit } from '@octokit/rest';
import { loadConfig, type Config } from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { createProviderAdapter } from '../session-runtime/adapters/index.js';
import type { ProviderAdapter } from '../session-runtime/adapters/index.js';
import { DEFAULT_POLICY } from '../session-runtime/containment-hooks.js';
import {
  admitProviders,
  type ProviderAdmissionBinding,
} from '../session-runtime/providers/startup-admission.js';
import { smokeTest, type SmokeProof } from '../session-runtime/providers/smoke-test.js';
import { killAllManagedProcessGroups } from '../session-runtime/managed-processes.js';
import { ImplementationCoordinator } from '../implementation/coordinator.js';
import { StateManager } from './state.js';
import { createControlServer } from './server.js';
import {
  createDegradedServer,
  type DegradedServerHandle,
  type DegradedState,
} from './degraded-server.js';
import {
  runStartupRetry,
  readStartupRetryOptions,
  type StartupRetryOptions,
} from './startup-retry.js';
import { createReleaseProposal } from './release.js';
import { RepoManager } from './repo-manager.js';
import {
  createWorkDetector,
  type WorkDetector,
  type FeaturePipelineWorkType,
} from './work-detection.js';
import { createPhaseHandlers } from './phases.js';
import {
  createDeploymentRegistry,
  type DeploymentRegistry,
} from './deployment-registry/index.js';
import { ensureWorkspaceRepo } from './workspace-bootstrap.js';
import { DecisionIndexManager } from './decision-escalation/manager.js';
import { readDecisionIndexConfig } from './decision-escalation/config.js';
import { decisionIdFor } from './decision-escalation/build-request.js';
import { decisionIdFor as mergeDecisionIdFor } from './merge-decision/build-request.js';
import {
  bootReconcile,
  supersedeIfMoot,
  markOverdue,
} from './decision-escalation/reconcile.js';
import {
  parseCockpitAnswer,
  isDecisionOwnedIssue,
  REQUEUE_LABEL,
} from './decision-escalation/resume-consumer.js';
import {
  classifyBatch,
  type BatchClassifierConfig,
} from './batch-classifier.js';
import { createWebsitePhaseHandlers } from './phases-website.js';
import { readAgencyConfig } from './agency-config.js';
import { runPipeline } from './pipeline.js';
import { createPhaseLabelMirror } from './phase-labels.js';
import { getPipeline, getStartPhase } from './fsm.js';
import { selectVariant } from './variants.js';
import { notify } from './notify.js';
import type {
  ProviderDefinition,
  RunState,
  RuntimeSourceStatus,
  WorkRequest,
} from '../types.js';
import { ok, err, type Result } from '../lib/result.js';
import {
  buildRuntimeSourcePolicy,
  validateRuntimeSource,
} from './runtime-source.js';
import { RemoteControlManager } from './remote-control.js';
import {
  createDbClient,
  createPostgresStores,
  readCredentialKey,
} from '@auto-claude/db';
import {
  PostgresConfigReader,
  type ConfigReader,
} from '../data/config-reader.js';
import {
  PostgresRunWriter,
  toDbOutcome,
  type RunWriter,
} from '../data/run-writer.js';
import { readDaemonDataBackendKind } from '../data/backend-kind.js';
import {
  PostgresRepoDataSource,
  type RepoDataSource,
} from '../data/repo-source.js';
import {
  PostgresRunHistory,
  type RunHistoryReader,
  type RunMaintenance,
} from '../data/run-history.js';
import { GotchaStore } from '../knowledge/gotcha-store.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { DEFAULT_POLICIES } from '../knowledge/policy-registry.js';
import { validatePromptContracts } from '../knowledge/prompt-contracts.js';
import { join } from 'path';
import { createReviewScheduler } from '../coordination/review-scheduler.js';
import { createPOAgent } from '../coordination/po-agent.js';
import { createTechLeadScheduler } from '../coordination/tech-lead-scheduler.js';
import {
  createCoordinator,
  type CoordinatorConfig,
} from '../coordination/coordinator.js';
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
import { mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import type { Proposal, IdeaSubmission } from '../coordination/types.js';
import {
  buildProductOwnerSessionVariables,
  PRODUCT_OWNER_SNAPSHOT_CONFIG,
} from './po-snapshot.js';

let dailyRunCount = 0;
let dailyRunCountResetDate = new Date().toISOString().split('T')[0];

// Mirrors the config-reader's DEFAULT_SYNC_INTERVAL_MS (60s). Used as the
// background degraded-recovery poll cadence when no explicit opts are passed.
const DEFAULT_SYNC_INTERVAL_MS = 60_000;

export interface StartDaemonOptions {
  startupRetry?: Partial<StartupRetryOptions>;
  degradedRecovery?: {
    intervalMs: number;
    delay?: (ms: number) => Promise<void>;
  };
  /**
   * Override the decision-escalation index manager (tests inject a manager backed
   * by a real writer over a temp sqlite, or a throwing stub for fail-closed
   * coverage). Production constructs one from `readDecisionIndexConfig(stateDir)`.
   */
  decisionManager?: DecisionIndexManager;
}

export async function startDaemon(
  configPath: string,
  opts?: StartDaemonOptions,
): Promise<Result<void>> {
  // 0. Validate GITHUB_TOKEN — required for Octokit (labeling, commenting, notifications)
  if (
    process.env.GITHUB_TOKEN === undefined ||
    process.env.GITHUB_TOKEN === ''
  ) {
    return err(
      new Error(
        'GITHUB_TOKEN environment variable is not set. The daemon requires a GitHub token to interact with issues and pull requests.',
      ),
    );
  }

  // 1. Load config
  const configResult = await loadConfig(configPath);
  if (!configResult.ok) return configResult;
  const config = configResult.value;

  // 1b. Validate runtime source before prompt cache prewarming, crash resumption,
  // and work detection can consume a mutable or stale checkout.
  const runtimeSourcePolicy = buildRuntimeSourcePolicy(config, process.cwd());
  let runtimeSourceStatus = await validateRuntimeSource(runtimeSourcePolicy);
  if (!runtimeSourceStatus.healthy) {
    console.warn(
      `[daemon] Runtime source unhealthy (${runtimeSourceStatus.failureKind ?? 'unknown'}): ${runtimeSourceStatus.message ?? 'no detail'}`,
    );
    if (runtimeSourceStatus.action === 'fail') {
      return err(
        new Error(
          `Runtime source preflight failed: ${runtimeSourceStatus.message ?? runtimeSourceStatus.failureKind ?? 'unknown'}`,
        ),
      );
    }
  }

  // 1c. Validate prompt contracts — refuse to boot if any registered prompt has drifted
  // from its declared contract. Production gate against drift introduced by prompt-optimizer
  // proposals or operator edits — neither of which CI can see.
  const promptsDirPath =
    process.env['PROMPTS_DIR'] ??
    join(import.meta.dirname, '../../../../prompts');
  const contractCheck = await validatePromptContracts(promptsDirPath);
  if (!contractCheck.ok) {
    console.error(
      `[daemon] Prompt contract validation failed:\n${contractCheck.error.message}`,
    );
    return err(contractCheck.error);
  }
  console.log(
    `[daemon] Prompt contracts validated (${contractCheck.value.checked} prompts)`,
  );

  // 1d. Pre-warm the prompt template cache after runtime source preflight.
  // This keeps the cache tied to the validated source rather than whichever
  // branch the process happens to be on after prior git operations.
  // Keep the original startup-branch invariant for legacy deployments.
  //
  // Pre-warm the prompt template cache while HEAD is still on the daemon's
  // startup branch (typically `dev`). Pipeline phases like coordinator.implement
  // and integrateToStaging move HEAD in mainRepoRoot during normal operation,
  // and prompts/*.md is read from that working copy. Without pre-warming, the
  // first session that loads a prompt mid-pipeline can cache a stale version
  // from the feature branch the daemon happens to be checked out to at that
  // moment. Pre-warming freezes a known-good revision for the daemon's lifetime.
  const { preloadPromptCache } = await import('../session-runtime/runtime.js');
  const preloaded = await preloadPromptCache();
  console.log(`[daemon] Prompt cache pre-warmed (${preloaded} prompts)`);

  const { preloadGovernanceContext } =
    await import('../session-runtime/governance-context.js');
  try {
    const governance = await preloadGovernanceContext(config, process.cwd());
    console.log(
      `[daemon] Governance context loaded from ${governance.sourcePath}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // 1e. Autonomous/container gate: clear the CLI "Workspace not trusted" gate
  // for the daemon's OWN cwd (static) the root-safe way. This covers
  // control-plane claude invocations that run in the daemon cwd (e.g. proactive
  // reviews scoped to the repo root, and `claude remote-control` when an
  // operator opts in) — none of which can use --dangerously-skip-permissions
  // (remote-control has no such flag, and the daemon runs as root). Per-worker
  // worktree trust is seeded separately in the CLI adapter before each spawn.
  const skipPermissions =
    config.autonomous === true ||
    process.env['AUTO_CLAUDE_SKIP_PERMISSIONS'] === '1';
  if (skipPermissions) {
    try {
      const { seedClaudeProjectTrust } =
        await import('../session-runtime/claude-project-trust.js');
      await seedClaudeProjectTrust(process.cwd());
      console.log(
        `[daemon] Workspace trust seeded for daemon cwd ${process.cwd()} (autonomous mode).`,
      );
    } catch (e) {
      console.warn(
        `[daemon] Workspace-trust seed for daemon cwd failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // 2. Initialize state
  const stateDir = 'state';
  const stateMgr = new StateManager(stateDir);
  await stateMgr.initialize();

  // 2b. Decision-escalation index (optional, flag-gated). Constructed + init'd
  // here; injected into every phase-handler build site + resumeParkedRuns. When
  // the flag is off, init() is a no-op (no native import) and ledger() throws —
  // callers guard on isEnabled() so disabled deployments are unaffected.
  //
  // FIX 1: the whole construct + init + boot-reconcile sits inside the graceful
  // boot try/catch so ANY throw here (config read, key generation on a bad
  // stateDir, native import/open failure not already swallowed by init's own
  // fail-closed catch) degrades via `return err(...)` instead of aborting boot
  // with an unhandled exception. A flag-OFF daemon must boot exactly as before.
  let decisionManager: DecisionIndexManager;
  try {
    decisionManager =
      opts?.decisionManager ??
      new DecisionIndexManager(readDecisionIndexConfig(stateDir));
    await decisionManager.init();
    // Boot reconcile: complete any in-flight outbox effects a prior crash left
    // mid-flight. No-op when disabled; fail-safe (logs, never throws) when enabled.
    await bootReconcile(decisionManager);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // 2c. Deployment registry (optional, flag-gated). A malformed deployment
  // profile is rejected at registration; the registry is left empty so the
  // integrate handler falls back to its flag-OFF unconditional merge.
  const deploymentRegistry = createDeploymentRegistry();
  if (config.deployment !== undefined) {
    const registered = deploymentRegistry.register(
      config.deployment.id,
      config.deployment.profile,
    );
    if (!registered.ok) {
      console.error(
        `[daemon] Deployment registration failed for ${config.deployment.id}: ${registered.offenders.join('; ')}`,
      );
    }
  }

  // Validate the control host early (hoisted from the control-server step):
  // the throwaway degraded server binds it during the startup-degraded window,
  // so it must be a valid IPv4 address before any server.listen().
  const envHost = process.env.DAEMON_HOST;
  const daemonHost = envHost ?? config.controlHost;
  const daemonHostSource =
    envHost !== undefined ? 'DAEMON_HOST' : 'controlHost';
  if (isIP(daemonHost) !== 4) {
    return err(
      new Error(
        `Invalid ${daemonHostSource}: "${daemonHost}" — must be a valid IPv4 address`,
      ),
    );
  }

  // Initialize data layer. After data-platform cutover the daemon uses the
  // project-owned Postgres stores only; missing or retired backends fail fast.
  try {
    readDaemonDataBackendKind();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  let configReader: ConfigReader | null = null;
  let runWriter: RunWriter | null = null;
  let repoSource: RepoDataSource | null = null;
  let runHistory: RunHistoryReader | null = null;
  let runMaintenance: RunMaintenance | null = null;
  let postgresClient: ReturnType<typeof createDbClient> | null = null;

  try {
    postgresClient = createDbClient({ maxConnections: 8 });
    const stores = createPostgresStores(postgresClient.db, {
      credentialKey: readCredentialKey(),
    });
    configReader = new PostgresConfigReader(
      stores.settings,
      stores.repos,
      stores.plugins,
    );
    runWriter = new PostgresRunWriter(stores.runs, stores.costs);
    repoSource = new PostgresRepoDataSource(stores.repos, stores.credentials);
    const history = new PostgresRunHistory(stores.runs);
    runHistory = history;
    runMaintenance = history;
  } catch (e) {
    await postgresClient?.sql.end();
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Phase C + D — degraded startup window. Bind a throwaway observability
  // server on the control port, then run a bounded inline retry of the initial
  // config fetch. On `rejected` (permanent misconfig) fail loudly; on
  // `exhausted` (transient outage) block in a background-retry loop until the
  // Data Service recovers. The real startup body below is UNCHANGED and runs
  // linearly only once config has loaded.
  const degradedState: DegradedState = { lastConfigError: null };
  const degraded = createDegradedServer(
    config.controlPort,
    daemonHost,
    () => degradedState,
  );
  const startResult = await degraded.start();
  if (!startResult.ok) {
    await postgresClient.sql.end();
    return startResult;
  }

  // Temporary signal handlers: the daemon's normal SIGTERM/SIGINT handlers are
  // only registered late in the (unchanged) startup body. A signal arriving
  // during the possibly-long degraded block would otherwise skip cleanup, so
  // we register temporary handlers that close the degraded server + end the DB
  // client. They are removed at the port-handoff point (after degraded.close()).
  const degradedSignalHandler = (): void => {
    void (async () => {
      await degraded.handle.close().catch(() => {});
      await postgresClient!.sql.end().catch(() => {});
      process.exit(0);
    })();
  };
  process.on('SIGTERM', degradedSignalHandler);
  process.on('SIGINT', degradedSignalHandler);

  try {
    const retryOptions: StartupRetryOptions = {
      ...readStartupRetryOptions(process.env),
      ...opts?.startupRetry,
    };
    const recovery = opts?.degradedRecovery ?? {
      intervalMs: DEFAULT_SYNC_INTERVAL_MS,
    };
    const result = await runStartupRetry(
      () => configReader!.tryFetch(),
      retryOptions,
      (attempt) => {
        if (!('category' in attempt)) return; // outcome === 'ok'
        degradedState.lastConfigError = {
          category: attempt.category,
          cause: attempt.cause,
        };
        console.log(
          `[daemon] startup config fetch failed (attempt ${attempt.attempt}/${attempt.total}, ${attempt.category}, ${attempt.cause.code ?? 'no-code'}): ${attempt.cause.message}`,
        );
      },
    );
    if (result.kind === 'rejected') {
      console.error(
        `[daemon] FATAL startup config rejected: ${result.failure.cause.code ?? 'no-code'}: ${result.failure.cause.message}`,
      );
      await degraded.handle.close();
      await postgresClient.sql.end();
      process.off('SIGTERM', degradedSignalHandler);
      process.off('SIGINT', degradedSignalHandler);
      // Attach cause so main.ts formatStartupError prints the `caused by:` line.
      return err(
        new Error(
          `startup config rejected: ${result.failure.cause.code ?? 'no-code'}: ${result.failure.cause.message}`,
          { cause: result.failure.cause },
        ),
      );
    }
    if (result.kind === 'exhausted') {
      console.warn(
        `[daemon] startup config exhausted ${retryOptions.maxAttempts} attempts — entering startup-degraded mode; background retry continues`,
      );
      await runDegradedUntilRecovered(
        configReader!,
        degradedState,
        degraded.handle,
        postgresClient,
        {
          intervalMs: recovery.intervalMs,
          delay: recovery.delay,
          maxConsecutiveStuck: config.maxConsecutiveStuck,
          webhooks: config.webhooks,
        },
      );
    }
    // Port handoff: release the control port for the real server below, and
    // hand signal handling back to the normal startup body's handlers.
    await degraded.handle.close();
    process.off('SIGTERM', degradedSignalHandler);
    process.off('SIGINT', degradedSignalHandler);
  } catch (e) {
    await degraded.handle.close().catch(() => {});
    await postgresClient.sql.end().catch(() => {});
    process.off('SIGTERM', degradedSignalHandler);
    process.off('SIGINT', degradedSignalHandler);
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // ---- existing startup body UNCHANGED from here ----
  // start() is now timer-only (config already loaded by the inline/background
  // tryFetch above), so it does not re-fetch.
  await configReader.start();

  const orphaned = await runMaintenance?.markInProgressRunsStuck();
  if (orphaned !== null && orphaned !== undefined && orphaned > 0) {
    console.log(
      `[daemon] Marked ${orphaned} orphaned in-progress runs as stuck`,
    );
  }

  // 3. Initialize services
  const costTracker = new CostTracker({
    dailyBudget:
      configReader?.getGlobalConfig()?.dailyBudgetLimit ?? config.dailyBudget,
    perRunBudget: config.perRunBudget, // per-run budget is repo-specific, handled per-run
  });
  const runtime = new SessionRuntime(config, costTracker);

  // 3a. Startup smoke-proof admission (opt-in; gate-off path is a byte-identical
  // NO-OP). Each configured provider/model binding is proven in a disposable
  // workspace before the daemon binds the control server. Required providers
  // that fail abort startup; optional failures are degraded but not fatal.
  if (config.providers?.requireSmokeProof === true) {
    const registry = runtime.getProviderRegistry();
    const skipPermissions =
      config.autonomous === true ||
      process.env['AUTO_CLAUDE_SKIP_PERMISSIONS'] === '1';

    const runSmoke = async (
      provider: ProviderDefinition,
      modelBinding: string,
    ): Promise<SmokeProof> => {
      const baseAdapter = createProviderAdapter(provider);
      const workspace = await mkdtemp(
        join(tmpdir(), `smoke-${provider.name}-`),
      );
      const smokeAdapter: ProviderAdapter = {
        capabilities: () => baseAdapter.capabilities(),
        abort: (handle) => baseAdapter.abort(handle),
        resume: (def, prompt, continuationId, options) =>
          baseAdapter.resume(def, prompt, continuationId, {
            ...options,
            cwd: workspace,
            containmentPolicy: DEFAULT_POLICY,
            skipPermissions,
          }),
        spawn: (def, prompt, options) =>
          baseAdapter.spawn(def, prompt, {
            ...options,
            cwd: workspace,
            containmentPolicy: DEFAULT_POLICY,
            skipPermissions,
          }),
      };
      try {
        return await smokeTest(provider, modelBinding, {
          adapter: smokeAdapter,
          observedChange: async () => {
            try {
              await stat(join(workspace, 'smoke-proof.txt'));
              return true;
            } catch {
              return false;
            }
          },
        });
      } finally {
        await rm(workspace, { recursive: true, force: true }).catch(() => {});
      }
    };

    const providers: ProviderAdmissionBinding[] = [];
    for (const provider of Object.values(config.providers.definitions)) {
      for (const tier of provider.supportedModelTiers) {
        providers.push({
          provider,
          modelBinding: provider.model ?? tier,
          tier,
          required: provider.required === true,
        });
      }
    }

    const admission = await admitProviders({
      registry,
      providers,
      requireSmokeProof: true,
      runSmoke,
      // Unbound work resolves through defaultProvider then the fallback chain —
      // admission must keep that path usable, not just any single provider.
      criticalChain: [
        config.providers.defaultProvider,
        ...config.providers.fallbackChain,
      ],
      logger: {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
        error: (message) => console.error(message),
      },
    });

    if (admission.aborted === true) {
      // Mirror the earlier startup-failure paths: release the resources already
      // started above (config-reader polling interval + Postgres client) before
      // returning, so a non-exiting caller/test does not leak them.
      configReader.stop();
      await postgresClient?.sql.end().catch(() => {});
      return err(
        new Error(
          `Startup aborted by smoke admission: ${admission.abortReasons.join(', ')}`,
        ),
      );
    }
  }
  const batchClassifierConfig: BatchClassifierConfig = {
    maxBatchSize: config.classifierBatchSize,
    fallbackOnFailure: true,
  };
  const gotchasPath = join(stateDir, 'gotchas.jsonl');
  const gotchaStore = new GotchaStore(gotchasPath);
  const knowledgeStore = new KnowledgeStore(
    join(stateDir, 'knowledge.jsonl'),
    DEFAULT_POLICIES,
    gotchasPath,
  );
  // Resolve the worktree base. Native: cwd is already the target checkout
  // (unchanged). Container / fresh host: cwd is not a git repo → clone
  // config.repo into config.workspaceRoot. Without this the detect phase's
  // `git worktree add` fails with "not a git repository" and every run stucks.
  const repoRoot = await ensureWorkspaceRepo(config, {
    log: (m) => console.log(m),
  });
  // maxDiffLines: 2000 — real features (multi-file specs, e.g., knowledge-sync, multi-provider)
  // routinely produce 500–1500 line diffs. The historical 300 ceiling silently failed any
  // substantive feature implementation. Review gates remain the safety net for bad large diffs.
  const coordinator = new ImplementationCoordinator(
    runtime,
    repoRoot,
    2000,
    2000,
    gotchaStore,
    knowledgeStore,
  );

  // 3b. Start Knowledge Sync schedule (opt-in; no-op when knowledgeSync.enabled is false)
  let knowledgeSyncPoller: ReturnType<typeof setInterval> | null = null;
  if (config.knowledgeSync?.enabled === true) {
    const syncService = createKnowledgeSyncService(
      config.knowledgeSync,
      knowledgeStore,
      stateDir,
    );
    const intervalMs = config.knowledgeSync.syncIntervalMinutes * 60_000;
    knowledgeSyncPoller = setInterval(() => {
      syncService
        .triggerSync()
        .catch((e) => console.warn('[knowledge-sync] cycle error:', e));
    }, intervalMs);
    // Trigger an initial cycle on startup
    syncService
      .triggerSync()
      .catch((e) => console.warn('[knowledge-sync] startup cycle error:', e));
  }

  // 3c. Start Remote Control — opt-in. It's an interactive claude.ai feature
  // (needs a trusted workspace + interactive login, no permission-bypass flag)
  // and is not part of the autonomous worker loop. Default off so a root
  // container doesn't crash-loop on the trust gate; operators enable it via
  // config.remoteControl.enabled or AUTO_CLAUDE_REMOTE_CONTROL=1.
  const remoteControl = new RemoteControlManager();
  const remoteControlEnabled =
    config.remoteControl?.enabled === true ||
    process.env['AUTO_CLAUDE_REMOTE_CONTROL'] === '1';
  if (remoteControlEnabled) {
    remoteControl.start();
  } else {
    console.log(
      '[daemon] Remote Control disabled (opt-in: config.remoteControl.enabled or AUTO_CLAUDE_REMOTE_CONTROL=1).',
    );
  }

  // 3c. Start Review Scheduler
  const reviewScheduler = createReviewScheduler(
    {
      spawnReviewSession: async (category, maxIssues) => {
        const result = await runtime.spawnSession(
          'codebase-reviewer',
          {
            // Scope the proactive review to the repo root. Without a workspacePath
            // the CLI adapter falls back to an empty temp dir (SEC-34 containment
            // path), leaving the reviewer with no codebase to review (#692).
            workspacePath: repoRoot,
            variables: {
              category,
              maxIssues: String(maxIssues),
              rubric: '',
              recentCommits: '',
            },
          },
          0, // no issue number — proactive review
        );
        if (!result.ok) {
          console.error(
            '[review-scheduler] session failed:',
            result.error.message,
          );
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
        const variables = await buildProductOwnerSessionVariables(
          {
            repoRoot,
            stateDir,
            loadProposals: loadPOProposals,
            loadIdeas: loadPOIdeas,
            github: poSnapshotGithub,
          },
          poSnapshotConfig,
        );
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

  const techProposalStore = new TechProposalStore(
    techLeadProposalsDir,
    techLeadEnrichmentsDir,
  );
  await techProposalStore.init();

  const techLeadScheduler = createTechLeadScheduler(
    {
      assembleDigest: async (trigger, cfg) => {
        return assembleSignalDigest(
          trigger,
          {
            getReviewFindings: async () => [],
            getRunOutcomes: async () => [],
            getTestHealth: async () => [],
            getActiveProposals: async () =>
              techProposalStore.loadActiveProposals(),
            getPriorRejections: async () =>
              techProposalStore.loadRejectedProposals(),
          },
          {
            lookbackWindowMs: cfg.lookbackWindowMs,
            maxEntriesPerSection: cfg.maxEntriesPerSection,
            deferredWorkPaths: [join(repoRoot, 'packages')],
            deferredWorkExclude: [
              'node_modules',
              'dist',
              '.git',
              'coverage',
              '.next',
            ],
            workspacePath: repoRoot,
            traceabilityPath: join(repoRoot, '.specify', 'traceability.yml'),
          },
        );
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
          const duplicate = await techProposalStore.findDuplicate(
            proposal.proposalType,
            proposal.affectedAreas,
          );
          if (duplicate) {
            const updated = {
              ...duplicate,
              evidence: [...duplicate.evidence, ...proposal.evidence],
            };
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
          if (
            !isTerminalStatus(proposal.status) &&
            new Date(proposal.expiresAt).getTime() <= now
          ) {
            await techProposalStore.saveProposal({
              ...proposal,
              status: 'expired',
            });
            swept++;
          }
        }
        return swept;
      },
      // TODO(#344): Wire to ProtocolExecutor when available
      routeToProtocol: async (trigger) => {
        console.log(
          `[tech-lead-scheduler] protocol trigger: ${trigger} (routing not yet wired)`,
        );
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
        resolveConflicts: async (_cwd, _cfg, _session) => ({
          resolved: false,
          needsHuman: true,
        }),
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
        spawnWorker: async () => {
          /* wired in future — processWorkRequest will be called here */
        },
        checkDiskSpace: async () => {
          try {
            const stats = await statfs(process.cwd());
            return (
              stats.bavail * stats.bsize >
              config.coordination.diskSpaceThreshold
            );
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
            console.warn(
              `[daemon] Auto-paused: coordinator hit ${consecutiveErrors} consecutive tick errors`,
            );
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
  let paused = shouldPauseForRuntimeSource(runtimeSourceStatus);
  let draining = false;
  let activeRuns = 0;
  let shuttingDown = false;
  let consecutiveStuckCount = 0;
  const activeIssues = new Set<number>(); // Persists across poll cycles — prevents duplicate runs

  const stuckBackoff = new Map<
    string,
    { count: number; lastStuckAt: number }
  >();
  function issueKey(owner: string, repo: string, issue: number): string {
    return `${owner}/${repo}#${issue}`;
  }
  function isBackedOff(key: string, cfg: Config): boolean {
    const entry = stuckBackoff.get(key);
    if (!entry) return false;
    const backoff = Math.min(
      cfg.retryBackoffBaseMs * Math.pow(2, entry.count - 1),
      cfg.retryBackoffMaxMs,
    );
    return Date.now() - entry.lastStuckAt < backoff;
  }

  async function refreshRuntimeSourceForWork(
    context: string,
  ): Promise<Result<void>> {
    const latest = await validateRuntimeSource(runtimeSourcePolicy);
    runtimeSourceStatus = latest;
    if (latest.healthy || latest.action === 'warn') return ok(undefined);

    paused = true;
    const message =
      latest.message ?? latest.failureKind ?? 'unknown runtime source failure';
    console.warn(
      `[daemon] Runtime source preflight blocked ${context} (${latest.failureKind ?? 'unknown'}): ${message}`,
    );
    return err(new Error(`Runtime source preflight failed: ${message}`));
  }

  /** Shared handler for run outcomes — tracks stuck count and auto-pause. */
  const handleRunOutcome = (
    outcome: string,
    issueNumber: number,
    owner?: string,
    repo?: string,
  ) => {
    if (outcome === 'paused') {
      if (!paused) {
        paused = true;
        console.warn(
          `[daemon] Auto-paused: daily budget exceeded (issue #${issueNumber})`,
        );
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
      if (
        owner !== undefined &&
        owner !== '' &&
        repo !== undefined &&
        repo !== ''
      ) {
        const key = issueKey(owner, repo, issueNumber);
        const prev = stuckBackoff.get(key);
        stuckBackoff.set(key, {
          count: (prev?.count ?? 0) + 1,
          lastStuckAt: Date.now(),
        });
      }
      console.log(
        `[daemon] Consecutive stuck count: ${consecutiveStuckCount}/${config.maxConsecutiveStuck}`,
      );
      if (consecutiveStuckCount >= config.maxConsecutiveStuck && !paused) {
        paused = true;
        console.warn(
          `[daemon] Auto-paused: ${consecutiveStuckCount} consecutive stuck runs reached threshold`,
        );
        void notify(config.webhooks, {
          event: 'auto-paused',
          issueNumber,
          phase: 'stuck',
          message: `Daemon auto-paused after ${consecutiveStuckCount} consecutive stuck runs`,
        });
      }
    } else if (outcome === 'parked') {
      // Gate-parked run — no-op, don't increment stuck or pause daemon
      console.log(
        `[daemon] Run #${issueNumber} parked at gate, awaiting approval`,
      );
    } else {
      // Success or other non-error outcome — clear backoff for this issue
      if (
        owner !== undefined &&
        owner !== '' &&
        repo !== undefined &&
        repo !== ''
      ) {
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

  // 5. Build RepoManager
  let repoManager: RepoManager | null = null;

  {
    // DB mode
    repoManager = new RepoManager(
      repoSource,
      config.pollIntervalMs,
      async (repoId, owner, name, detector) => {
        if (paused || draining || shuttingDown) return;
        // Decision-index tick maintenance (enabled-guarded + fail-safe). Runs each
        // tick BEFORE the concurrency/source-ready early-returns so a busy daemon
        // still ages and recovers its pending decisions.
        if (decisionManager.isEnabled()) {
          // Periodic reconcile drives any in-flight effect forward. bootReconcile
          // runs ONCE at startup, so a crash between the resume requeue's save and
          // its advanceToResumed (or any other mid-effect crash) would otherwise
          // strand a row non-terminal until the next restart. The per-tick sweep
          // drains it across subsequent ticks. reconcile() is idempotent (it
          // probes effects), so a no-op tick is cheap.
          try {
            await decisionManager.ledger().reconcile();
          } catch (e) {
            console.error('[daemon] tick reconcile error:', e);
          }
          // Overdue marking: mark past-expiry notified/viewed decisions stale
          // (mark only — no delivery). markOverdue never throws.
          try {
            await markOverdue(decisionManager.ledger(), new Date());
          } catch (e) {
            console.error('[daemon] markOverdue error:', e);
          }
        }
        if (
          activeRuns >=
          (configReader?.getGlobalConfig()?.concurrencyLimit ??
            config.maxConcurrentRuns)
        )
          return;
        const sourceReady = await refreshRuntimeSourceForWork('work detection');
        if (!sourceReady.ok) return;
        costTracker.maybeResetDaily();
        const claimedIssues = new Set<number>();
        // DECISION-OWNED skip set (flag-ON only): the cockpit's requeue label is
        // `ready` — the SAME label new-work detection polls. Without this guard the
        // new-work poll would spawn a DUPLICATE run for a parked decision issue
        // (the #1 loop-killer). The set unions the live parked-l2-gate issue
        // numbers (catches a stripped/edited body marker) with a per-request body-
        // marker check (catches the post-unpark stale-`ready` window). The cockpit
        // resume is the resume-poll's job, never fresh work. Flag-OFF: empty set,
        // so detection is byte-identical to today (no skip, no extra GitHub calls).
        const parkedDecisionIssues = new Set<number>();
        if (decisionManager.isEnabled()) {
          try {
            for (const p of await stateMgr.findParkedRuns()) {
              // l2-gate AND integrate parks are decision-owned: new-work detection
              // must not double-spawn them. (The integrate-park operator-answer →
              // re-enter resume itself lands with follow-up #9.)
              if (p.pausedAtPhase === 'l2-gate' || p.pausedAtPhase === 'integrate')
                parkedDecisionIssues.add(p.issueNumber);
            }
          } catch (e) {
            console.warn(
              `[daemon] decision-owned skip set unavailable (continuing): ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        const isDecisionOwned = (request: WorkRequest): boolean =>
          decisionManager.isEnabled() &&
          isDecisionOwnedIssue(
            request.body,
            request.issueNumber,
            parkedDecisionIssues,
          );
        const workResult = await detector.detectReadyWork();
        if (!workResult.ok) {
          // TODO: proactive token health check — if 401, mark connection token_invalid
          return;
        }
        const readyToProcess: WorkRequest[] = [];
        for (const request of workResult.value) {
          if (readyToProcess.length >= batchClassifierConfig.maxBatchSize)
            break;
          if (
            activeRuns >=
            (configReader?.getGlobalConfig()?.concurrencyLimit ??
              config.maxConcurrentRuns)
          )
            break;
          if (paused || draining || shuttingDown) break;
          if (activeIssues.has(request.issueNumber)) continue; // Already running
          if (isDecisionOwned(request)) {
            // Parked decision issue carrying the cockpit's `ready` requeue label —
            // NOT fresh work; the resume-poll owns it. HARD guard against duplicate runs.
            continue;
          }
          if (isBackedOff(issueKey(owner, name, request.issueNumber), config)) {
            console.log(
              `[daemon] Issue #${request.issueNumber} is in backoff — skipping`,
            );
            continue;
          }
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          claimedIssues.add(request.issueNumber);
          activeIssues.add(request.issueNumber);
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          readyToProcess.push(request);
        }
        const preClassifiedReady = await preClassifyReadyWork(
          runtime,
          readyToProcess,
          batchClassifierConfig,
        );
        for (const request of preClassifiedReady) {
          processWorkRequest(
            config,
            repoId,
            owner,
            name,
            request,
            runtime,
            coordinator,
            costTracker,
            stateMgr,
            detector,
            stateDir,
            runWriter ?? undefined,
            configReader ?? undefined,
            runHistory ?? undefined,
            repoRoot,
            knowledgeStore,
            repoManager,
            decisionManager,
            deploymentRegistry,
          )
            .then((outcome) =>
              handleRunOutcome(outcome, request.issueNumber, owner, name),
            )
            .catch((e) =>
              console.error(`Run failed for #${request.issueNumber}:`, e),
            )
            .finally(() => {
              activeRuns--;
              activeIssues.delete(request.issueNumber);
              repoManager!.notifyRunEnd(repoId);
            });
        }

        // Bug-fix detection — lower priority than ready work (#284)
        if (paused || draining || shuttingDown) return;
        if (
          activeRuns >=
          (configReader?.getGlobalConfig()?.concurrencyLimit ??
            config.maxConcurrentRuns)
        )
          return;
        const bugResult = await detector.detectBugFixWork();
        if (
          bugResult.ok &&
          bugResult.value &&
          !claimedIssues.has(bugResult.value.issueNumber) &&
          !activeIssues.has(bugResult.value.issueNumber) &&
          !isDecisionOwned(bugResult.value)
        ) {
          const bugRequest = bugResult.value;
          const bugClaimResult = await detector.claimBugFixWork(
            bugRequest.issueNumber,
          );
          if (bugClaimResult.ok) {
            claimedIssues.add(bugRequest.issueNumber);
            activeIssues.add(bugRequest.issueNumber);
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(
              config,
              repoId,
              owner,
              name,
              bugRequest,
              runtime,
              coordinator,
              costTracker,
              stateMgr,
              detector,
              stateDir,
              runWriter ?? undefined,
              configReader ?? undefined,
              runHistory ?? undefined,
              repoRoot,
              knowledgeStore,
              repoManager,
              decisionManager,
              deploymentRegistry,
            )
              .then((outcome) =>
                handleRunOutcome(outcome, bugRequest.issueNumber, owner, name),
              )
              .catch((e) =>
                console.error(`Run failed for #${bugRequest.issueNumber}:`, e),
              )
              .finally(() => {
                activeRuns--;
                activeIssues.delete(bugRequest.issueNumber);
                repoManager!.notifyRunEnd(repoId);
              });
          }
        }

        // Feature-pipeline detection — lowest priority (#282)
        if (paused || draining || shuttingDown) return;
        if (
          activeRuns >=
          (configReader?.getGlobalConfig()?.concurrencyLimit ??
            config.maxConcurrentRuns)
        )
          return;
        const fpResult = await detector.detectFeaturePipelineWork();
        if (
          fpResult.ok &&
          fpResult.value &&
          !claimedIssues.has(fpResult.value.issueNumber) &&
          !activeIssues.has(fpResult.value.issueNumber) &&
          !isDecisionOwned(fpResult.value)
        ) {
          const fpRequest = fpResult.value;
          const fpClaimResult = await detector.claimFeaturePipelineWork(
            fpRequest.issueNumber,
            fpRequest.workType as FeaturePipelineWorkType,
          );
          if (fpClaimResult.ok) {
            activeIssues.add(fpRequest.issueNumber);
            activeRuns++;
            repoManager!.notifyRunStart(repoId);
            processWorkRequest(
              config,
              repoId,
              owner,
              name,
              fpRequest,
              runtime,
              coordinator,
              costTracker,
              stateMgr,
              detector,
              stateDir,
              runWriter ?? undefined,
              configReader ?? undefined,
              runHistory ?? undefined,
              repoRoot,
              knowledgeStore,
              repoManager,
              decisionManager,
              deploymentRegistry,
            )
              .then((outcome) =>
                handleRunOutcome(outcome, fpRequest.issueNumber, owner, name),
              )
              .catch((e) =>
                console.error(`Run failed for #${fpRequest.issueNumber}:`, e),
              )
              .finally(() => {
                activeRuns--;
                activeIssues.delete(fpRequest.issueNumber);
                repoManager!.notifyRunEnd(repoId);
              });
          }
        }

        // Parked-run resume scan — after all normal work detection (mirrors legacy poller)
        await resumeParkedRuns().catch((e) =>
          console.error('[daemon] resumeParkedRuns error:', e),
        );
      },
    );

    // If config.repo is present, upsert it as a seed repo
    if (config.repo) {
      const upsertResult = await repoManager.upsertRepo(
        config.repo.owner,
        config.repo.name,
      );
      if (!upsertResult.ok) {
        console.warn(
          `[daemon] Could not upsert seed repo from config: ${upsertResult.error.message}`,
        );
      }
    }

    const initResult = await repoManager.initialize();
    if (!initResult.ok) {
      configReader?.stop();
      await decisionManager.close();
      await postgresClient?.sql.end();
      await remoteControl.stop();
      return initResult;
    }
  }

  // 6. Start control server (daemonHost validated in Phase B, above)
  const { server, start } = createControlServer(
    config.controlPort,
    {
      getStatus: () => {
        const { remote_control_url: _, ...safeState } =
          remoteControl.getState() ?? {};
        return {
          activeRuns,
          activeIssues: [...activeIssues],
          dailyRunCount,
          dailyCost: costTracker.getDailyCost(),
          paused,
          draining,
          consecutiveStuckCount,
          uptime: process.uptime(),
          runtimeSource: runtimeSourceStatus,
          ...safeState,
        };
      },
      pause: () => {
        paused = true;
      },
      resume: async () => {
        const sourceReady = await refreshRuntimeSourceForWork('resume');
        if (!sourceReady.ok) return sourceReady;
        paused = false;
        draining = false;
        return ok(undefined);
      },
      drain: () => {
        enterDrainMode();
      },
      cancelDrain: () => {
        if (draining && !shuttingDown) {
          draining = false;
          console.log('[daemon] Drain cancelled — resuming normal operation');
        }
      },
      retry: (_issueNumber) => err(new Error('retry not yet implemented')),
      reloadRepos: repoManager ? async () => repoManager!.reload() : undefined,
      restartRemoteControl: async () => {
        await remoteControl.restart();
      },
      scanIssues: repoManager ? async () => repoManager!.scanNow() : undefined,
      release: config.repo
        ? async () =>
            createReleaseProposal(
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
    },
    daemonHost,
  );
  const serverResult = await start();
  if (!serverResult.ok) {
    repoManager?.stop();
    configReader?.stop();
    await decisionManager.close();
    await postgresClient?.sql.end();
    await remoteControl.stop();
    return serverResult;
  }

  console.log(
    `Auto-Claude daemon started on ${daemonHost}:${config.controlPort}`,
  );

  // 6b. Crash resumption — resume incomplete runs from prior crash
  if (shouldPauseForRuntimeSource(runtimeSourceStatus)) {
    console.warn(
      '[daemon] Runtime source policy paused the daemon; skipping crash resumption until source health is restored',
    );
  }
  const incompleteRuns = shouldPauseForRuntimeSource(runtimeSourceStatus)
    ? []
    : await stateMgr.findIncompleteRuns();
  for (const run of incompleteRuns) {
    const runOwner = run.repoOwner ?? config.repo?.owner;
    const runRepoName = run.repoName ?? config.repo?.name;
    if (
      runOwner === undefined ||
      runOwner === '' ||
      runRepoName === undefined ||
      runRepoName === ''
    ) {
      console.warn(
        `[daemon] Skipping incomplete run #${run.issueNumber} — missing repo info`,
      );
      continue;
    }
    console.log(
      `[daemon] Resuming incomplete run #${run.issueNumber} from phase '${run.phase}'`,
    );
    run.deploymentId = config.deployment?.id;
    activeIssues.add(run.issueNumber);
    activeRuns++;

    // Look up repoId for DB-mode repo tracking
    const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
    if (repoManager && resumeRepoId) {
      repoManager.notifyRunStart(resumeRepoId);
    }

    const resumeToken =
      repoManager && resumeRepoId
        ? await repoManager.resolveTokenForRepo(resumeRepoId)
        : process.env.GITHUB_TOKEN;
    const notifyOctokit = new Octokit({ auth: resumeToken });
    const phaseLabelMirror = createPhaseLabelMirror(
      notifyOctokit,
      runOwner,
      runRepoName,
    );
    const agencyConfig = await readAgencyConfig(null, '');
    const resumedRequest: WorkRequest = {
      issueNumber: run.issueNumber,
      title: run.title,
      body: run.body ?? '',
      labels: run.labels ?? [],
      specRefs: run.specRefs ?? [],
    };
    const handlers =
      run.variant === 'website'
        ? createWebsitePhaseHandlers(
            agencyConfig,
            null,
            notifyOctokit,
            runOwner,
            runRepoName,
            run.issueNumber,
            null,
          )
        : createPhaseHandlers(
            config,
            runOwner,
            runRepoName,
            runtime,
            coordinator,
            notifyOctokit,
            resumedRequest,
            stateDir,
            runWriter ?? undefined,
            run.id,
            repoRoot,
            configReader?.getRepoConfig(runOwner, runRepoName)?.activePlugins,
            knowledgeStore,
            phaseLabelMirror,
            decisionManager,
            undefined,
            deploymentRegistry,
          );
    const table = getPipeline(run.variant);

    const resumeDetector = createWorkDetector(
      new Octokit({ auth: resumeToken }),
      runOwner,
      runRepoName,
    );
    runPipeline(
      run,
      table,
      handlers,
      stateMgr,
      costTracker,
      undefined,
      runWriter ?? undefined,
      phaseLabelMirror,
    )
      .then(async (result) => {
        console.log(
          `[daemon] Resumed run #${run.issueNumber} finished: ${result.outcome}`,
        );

        void runWriter?.upsertRun(run.id, {
          outcome: toDbOutcome(result.outcome),
          completed_at: new Date().toISOString(),
          total_cost: run.cost,
        });

        handleRunOutcome(
          result.outcome,
          run.issueNumber,
          runOwner,
          runRepoName,
        );

        if (result.outcome === 'stuck') {
          await resumeDetector.markStuck(
            run.issueNumber,
            result.error ?? 'Unknown error',
          );
          await notify(config.webhooks, {
            event: 'stuck',
            issueNumber: run.issueNumber,
            phase: run.phase,
            message: `Issue #${run.issueNumber} stuck: ${result.error ?? 'unknown'}`,
          });
        }
      })
      .catch((e) =>
        console.error(`Resumed run failed for #${run.issueNumber}:`, e),
      )
      .finally(() => {
        activeRuns--;
        activeIssues.delete(run.issueNumber);
        if (repoManager && resumeRepoId) {
          repoManager.notifyRunEnd(resumeRepoId);
        }
      });
  }

  // 6c. Heartbeat — write a timestamp file for operator monitoring (health.sh compatibility)
  const heartbeatPath = join(
    process.env.HOME ?? '/tmp',
    'logs',
    'claude-daemon.heartbeat',
  );
  const stopHeartbeat = startHeartbeat(heartbeatPath, config.pollIntervalMs);

  // 6d. resumeParkedRuns — check parked runs for l2-approved/l2-rejected label, re-enter pipeline
  async function resumeParkedRuns(): Promise<void> {
    if (paused || draining || shuttingDown) return;
    const sourceReady = await refreshRuntimeSourceForWork('parked run resume');
    if (!sourceReady.ok) return;
    const parkedRuns = await stateMgr.findParkedRuns();
    // Limit to 1 resume per cycle to avoid thundering-herd
    for (const run of parkedRuns.slice(0, 1)) {
      if (activeIssues.has(run.issueNumber)) continue; // already running
      const runOwner = run.repoOwner ?? config.repo?.owner;
      const runRepoName = run.repoName ?? config.repo?.name;
      if (
        runOwner === undefined ||
        runOwner === '' ||
        runRepoName === undefined ||
        runRepoName === ''
      ) {
        console.warn(
          `[daemon] resumeParkedRuns: skipping run #${run.issueNumber} — missing repo info`,
        );
        continue;
      }
      if (run.pausedAtPhase === 'l2-gate') {
        // Keep the l2-gate branch as the primary path; integrate handled below.
      } else if (run.pausedAtPhase === 'integrate') {
        await resumeIntegrateParkedRun(run, runOwner, runRepoName);
        continue;
      } else {
        // Only l2-gate and integrate parking are handled here.
        continue;
      }

      // Resolve token and Octokit once for all operations on this run
      const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
      const resumeToken =
        repoManager && resumeRepoId
          ? await repoManager.resolveTokenForRepo(resumeRepoId)
          : process.env.GITHUB_TOKEN;
      const runOctokit = new Octokit({ auth: resumeToken });
      const phaseLabelMirror = createPhaseLabelMirror(
        runOctokit,
        runOwner,
        runRepoName,
      );

      // Fetch current labels + state from GitHub
      let issueLabels: string[];
      let issueState: string;
      try {
        const { data: issue } = await runOctokit.issues.get({
          owner: runOwner,
          repo: runRepoName,
          issue_number: run.issueNumber,
        });
        issueLabels = (issue.labels ?? []).map((l) =>
          typeof l === 'string' ? l : (l.name ?? ''),
        );
        issueState = issue.state ?? 'open';
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: failed to fetch labels for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      // Decision id for this park cycle (epoch defaults to 1 for runs parked
      // before decisionEpoch existed). Shared by the moot-supersede and the
      // answer/resume paths below.
      const decisionId = decisionIdFor(
        `issue-${run.issueNumber}`,
        'l2-gate',
        run.decisionEpoch ?? 1,
      );

      // Moot decision: the issue this parked run was awaiting was CLOSED
      // out-of-band — its l2-gate decision can never be answered. Supersede the
      // ledger row (guarded: missing/terminal rows are skipped, fail-safe) so it
      // leaves the pending set, and skip the resume. We do NOT clear the parked
      // run state here (that closed-issue cleanup lives elsewhere); we only
      // settle the dangling decision.
      if (issueState === 'closed' && decisionManager.isEnabled()) {
        try {
          await supersedeIfMoot(decisionManager.ledger(), decisionId);
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: supersede-on-moot for closed #${run.issueNumber} failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        continue;
      }

      // RECOGNITION PRECEDENCE:
      //   1. Legacy operator labels (`l2-approved`/`l2-rejected`) — works flag-ON
      //      or OFF; unchanged path. Checked FIRST so a re-park after a cockpit
      //      approve (which synthesizes `l2-approved`) re-enters via THIS path —
      //      the merge-block re-park is therefore handled idempotently, and the
      //      `resumed`-status guard below never strands such a run.
      //   2. flag-ON cockpit answer — only when NO legacy label is present: the
      //      AUTHORITATIVE signal is a `**DecisionResponse**` comment whose JSON
      //      decision_id matches THIS run's deterministic id (epoch-keyed). The
      //      `answered`/`ready` labels + `pm-cockpit:requeue:` markers are discovery
      //      hints only — never the approve/reject choice, never required. A
      //      half-written answer (label flipped, comment absent / wrong-epoch) does
      //      NOT resume. SLICE 2 closes the loop here.
      let hasApproved = issueLabels.includes('l2-approved');
      let hasRejected = issueLabels.includes('l2-rejected');
      // Cockpit approve synthesizes the `l2-approved` label the l2-gate handler
      // needs (the cockpit posts a DecisionResponse, NOT the label), so the existing
      // handler can advance past the gate. Cockpit `ready` is cleaned up on resume.
      let synthesizeApprovedLabel = false;
      // Raw DecisionResponse comment body — surfaced for reject-feedback capture.
      let cockpitFeedbackBody: string | undefined;

      if (!hasApproved && !hasRejected && decisionManager.isEnabled()) {
        // IDEMPOTENCY GUARD (codex spar §5): if this decision was already driven to
        // terminal `resumed`, we already consumed this cockpit answer on a prior
        // tick — do NOT re-consume / re-requeue. This only gates the cockpit branch;
        // a re-park lands on the synthesized `l2-approved` legacy path above, so a
        // legitimate merge-block re-park is never stranded. FAIL-CLOSED: a ledger()
        // throw here stays parked this tick.
        let alreadyResumed = false;
        try {
          alreadyResumed =
            decisionManager.ledger().statusOf(decisionId) === 'resumed';
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: statusOf failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        if (alreadyResumed) continue;

        let comments: Array<{ body?: string | null }> = [];
        try {
          const res = await runOctokit.issues.listComments({
            owner: runOwner,
            repo: runRepoName,
            issue_number: run.issueNumber,
            per_page: 100,
          });
          comments = res.data ?? [];
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: failed to fetch comments for cockpit answer on #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        const answer = parseCockpitAnswer(comments, decisionId);
        if (!answer) continue; // no authoritative DecisionResponse yet — stay parked
        if (answer.choice === 'approve') {
          hasApproved = true;
          synthesizeApprovedLabel = true;
        } else {
          hasRejected = true;
          cockpitFeedbackBody = answer.feedbackBody;
        }
        console.log(
          `[daemon] resumeParkedRuns: cockpit answer (${answer.choice}) recognized for #${run.issueNumber} via DecisionResponse`,
        );
      }

      if (!hasApproved && !hasRejected) continue; // still waiting

      console.log(
        `[daemon] resumeParkedRuns: resuming #${run.issueNumber} (${hasApproved ? 'l2-approved' : 'l2-rejected'})`,
      );

      // `decisionId` (computed above) records the operator's answer and later
      // drives the ledger to `resumed`.
      // Approved takes precedence if (somehow) both labels are present.
      const rejectedResume = !hasApproved && hasRejected;
      const choice = hasApproved ? 'approve' : 'reject';

      // FIX 2 (flag-OFF blocker): the rejected-resume routing change (extra
      // listComments() call, l2Feedback capture, phase='l2-design', and clearing
      // the l2Gate/l2MergeBlocked notification flags) is the NEW flag-ON behavior.
      // origin/main resumes BOTH approved and rejected runs to phase='l2-gate'
      // with no extra GitHub call and no notification-flag change. Gate the whole
      // routing change behind isEnabled() so a flag-OFF daemon behaves EXACTLY
      // like origin/main. The logic itself is correct for flag-ON — only gated.
      const routeRejectedToL2Design = rejectedResume && decisionManager.isEnabled();

      // CRASH-SAFE ORDERING (1/2): record the operator's answer in the ledger
      // BEFORE mutating run state. answer() is answered-once (`.applied:false`
      // on replay — fine). FAIL-CLOSED: if the index is enabled but ledger()
      // throws (broken), skip this run this tick (stay parked) rather than
      // advancing on unconfirmed state.
      if (decisionManager.isEnabled()) {
        try {
          decisionManager.ledger().answer(decisionId, choice, 'operator');
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: decision-index answer failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
      }

      // For a rejected resume (FLAG ON ONLY), capture the rejection feedback and
      // route the run BACK to l2-design directly (fix for the pre-existing
      // dropped-feedback bug: we strip l2-rejected here, so the l2-gate handler
      // would never see it and never capture feedback / route to l2-design).
      // Approved resumes re-enter l2-gate unchanged. Flag OFF: skip entirely so
      // there is no extra listComments() call and feedback is left untouched
      // (matches origin/main).
      if (routeRejectedToL2Design) {
        // Sanitize identically to the l2-gate handler: strip {{placeholder}}
        // template patterns (prompt-injection defense) and cap length.
        const MAX_FEEDBACK_LENGTH = 4000;
        const captureFeedback = (raw: string): void => {
          run.l2Feedback = raw
            .replace(/\{\{[\w-]+\}\}/g, '')
            .slice(0, MAX_FEEDBACK_LENGTH);
        };
        if (cockpitFeedbackBody != null && cockpitFeedbackBody !== '') {
          // Cockpit reject: the authoritative DecisionResponse comment IS the
          // feedback (already fetched during recognition — no extra round-trip).
          captureFeedback(cockpitFeedbackBody);
        } else {
          // Legacy operator l2-rejected label: scan for the rejection comment.
          try {
            const comments = await runOctokit.issues.listComments({
              owner: runOwner,
              repo: runRepoName,
              issue_number: run.issueNumber,
              per_page: 20,
            });
            const rejectionComment = [...(comments.data ?? [])]
              .reverse()
              .find(
                (c) =>
                  c.body != null &&
                  (c.body.includes('REJECTED') ||
                    c.body.includes('l2-rejected')),
              );
            if (rejectionComment?.body != null && rejectionComment.body !== '') {
              captureFeedback(rejectionComment.body);
            }
          } catch (e) {
            console.warn(
              `[daemon] resumeParkedRuns: failed to fetch rejection comment for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }

      // Reset run state. FLAG ON + rejected -> route straight to l2-design
      // (feedback already captured above) so the rework cycle runs; mirror the
      // l2-gate rejection branch's notification resets so the next park
      // re-notifies and re-emits a fresh decision. Otherwise (approved, OR flag
      // OFF for either label) re-enter l2-gate unchanged — identical to
      // origin/main: no phase divergence, notification flags untouched.
      if (routeRejectedToL2Design) {
        run.phase = 'l2-design';
        run.l2GateNotified = false;
        run.l2MergeBlockedNotified = undefined;
      } else {
        run.phase = 'l2-gate';
      }
      run.pausedAtPhase = undefined;

      // SYNTHESIZE the l2-approved label for a cockpit approve (flag-ON only). The
      // cockpit posts a DecisionResponse, NOT the label, but the l2-gate handler
      // advances ONLY when it re-reads `l2-approved` on the issue — otherwise it
      // re-parks. Adding it BEFORE the durable save makes a post-save restart
      // re-enter via the legacy `l2-approved` path (idempotent: the answer replays).
      // A crash after save but before this add leaves the run un-parked at l2-gate
      // without the label; the handler then re-parks and the still-present cockpit
      // answer is re-recognized — recoverable, not stuck.
      if (synthesizeApprovedLabel) {
        try {
          await runOctokit.issues.addLabels({
            owner: runOwner,
            repo: runRepoName,
            issue_number: run.issueNumber,
            labels: ['l2-approved'],
          });
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: failed to synthesize l2-approved label for #${run.issueNumber} (continuing; handler may re-park): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // DURABLE COMMIT: persist the requeue BEFORE the (irreversible, remote)
      // gate-label removal. If we removed labels first and crashed before this
      // save, the run would restart still parked but with the trigger label gone
      // -> stuck forever, feedback lost. Save-first makes restart re-resume
      // idempotently (answer is answered-once; the requeue replays).
      await stateMgr.saveRunState(run);

      // Remove gate labels (best-effort) AFTER the durable save — awaiting,
      // rejected, AND the cockpit's `ready` requeue label must be cleared so the
      // l2-gate handler does not immediately re-trigger on resume AND the new-work
      // poll never re-claims this issue once it un-parks (the cockpit's `ready`
      // aliases the daemon's NEW-work label — codex spar §3 cleanup rule). We KEEP
      // the `answered` label + all comments/markers as audit + cockpit idempotency
      // evidence. `ready` is only stripped when the index is enabled (flag-OFF must
      // not touch a label it never reads, keeping that path byte-identical).
      const labelsToRemove = ['awaiting-l2-review', 'l2-rejected'];
      if (decisionManager.isEnabled()) labelsToRemove.push(REQUEUE_LABEL);
      for (const label of labelsToRemove) {
        try {
          await runOctokit.issues.removeLabel({
            owner: runOwner,
            repo: runRepoName,
            issue_number: run.issueNumber,
            name: label,
          });
        } catch {
          /* label may not exist — ignore */
        }
      }

      // CRASH-SAFE ORDERING (2/2): only AFTER the run-state requeue is committed
      // do we drive the ledger to terminal `resumed` via the real effect chain
      // (write_response -> requeue -> resumed). Never direct-apply resume_ack.
      // FAIL-CLOSED: a ledger() throw here logs but does not roll back the already
      // -committed requeue (the run is correctly advancing); boot reconcile will
      // complete any in-flight effect.
      if (decisionManager.isEnabled()) {
        try {
          await decisionManager.ledger().advanceToResumed(decisionId, 'requeue');
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: decision-index advanceToResumed failed for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Re-enter pipeline
      await reenterPipeline(run, runOwner, runRepoName, resumeRepoId, runOctokit, phaseLabelMirror);
    }

    async function resumeIntegrateParkedRun(
      run: RunState,
      runOwner: string,
      runRepoName: string,
    ): Promise<void> {
      // Resolve token and Octokit once for all operations on this run.
      const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
      const resumeToken =
        repoManager && resumeRepoId
          ? await repoManager.resolveTokenForRepo(resumeRepoId)
          : process.env.GITHUB_TOKEN;
      const runOctokit = new Octokit({ auth: resumeToken });
      const phaseLabelMirror = createPhaseLabelMirror(
        runOctokit,
        runOwner,
        runRepoName,
      );

      // Fetch current issue state from GitHub.
      let issueState: string;
      try {
        const { data: issue } = await runOctokit.issues.get({
          owner: runOwner,
          repo: runRepoName,
          issue_number: run.issueNumber,
        });
        issueState = issue.state ?? 'open';
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: failed to fetch issue state for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }

      // Decision id for this integrate park cycle (epoch defaults to 1 for runs
      // parked before mergeDecisionEpoch existed). Resolve ONCE and persist it onto
      // the run so the same concrete epoch keys the decision id, the approve
      // override, AND the integrate handler's `mergeDecisionEpoch !== undefined`
      // honor check — otherwise an approved run lacking the field would re-park with
      // the ledger already `resumed` and strand. Phase is baked into the builder.
      const mergeEpoch = run.mergeDecisionEpoch ?? 1;
      run.mergeDecisionEpoch = mergeEpoch;
      const decisionId = mergeDecisionIdFor(`issue-${run.issueNumber}`, mergeEpoch);

      // Moot decision: the issue this parked run was awaiting was CLOSED
      // out-of-band — its integrate decision can never be answered.
      if (issueState === 'closed' && decisionManager.isEnabled()) {
        try {
          await supersedeIfMoot(decisionManager.ledger(), decisionId);
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: supersede-on-moot for closed #${run.issueNumber} failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }

      // The integrate park requires the decision index enabled; there is no
      // legacy-label dual path.
      if (!decisionManager.isEnabled()) {
        return;
      }

      // IDEMPOTENCY GUARD: if this decision was already driven to terminal
      // `resumed`, do NOT re-consume / re-requeue.
      let alreadyResumed = false;
      try {
        alreadyResumed =
          decisionManager.ledger().statusOf(decisionId) === 'resumed';
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: statusOf failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      if (alreadyResumed) return;

      let comments: Array<{ body?: string | null }> = [];
      try {
        const res = await runOctokit.issues.listComments({
          owner: runOwner,
          repo: runRepoName,
          issue_number: run.issueNumber,
          per_page: 100,
        });
        comments = res.data ?? [];
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: failed to fetch comments for cockpit answer on #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }

      const answer = parseCockpitAnswer(comments, decisionId);
      if (!answer) return; // no authoritative DecisionResponse yet — stay parked

      console.log(
        `[daemon] resumeParkedRuns: cockpit answer (${answer.choice}) recognized for #${run.issueNumber} via DecisionResponse (integrate)`,
      );

      // CRASH-SAFE ORDERING (1/2): record the operator's answer in the ledger
      // BEFORE mutating run state. Answer with the RAW chosen_option (not the
      // normalized choice): the decision-index state machine validates the answered
      // id against the stored options[], so a pre-rename park whose stored approve
      // id is `approve-merge` must be answered with `approve-merge`, not `approve`.
      // FAIL-CLOSED: ledger throw -> stay parked.
      try {
        decisionManager
          .ledger()
          .answer(decisionId, answer.rawChosenOption, 'operator');
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: decision-index answer failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }

      if (answer.choice === 'approve') {
        run.mergeDecisionApprovedEpoch = mergeEpoch;
        run.phase = 'integrate';
      } else {
        // REJECT: capture operator feedback and route back to implement for rework.
        const MAX_FEEDBACK_LENGTH = 4000;
        run.mergeDecisionFeedback = answer.feedbackBody
          .replace(/\{\{[\w-]+\}\}/g, '')
          .slice(0, MAX_FEEDBACK_LENGTH);
        run.phase = 'implement';
        run.mergeDecisionBlockPublished = false;
      }
      run.pausedAtPhase = undefined;

      // DURABLE COMMIT: persist the requeue BEFORE driving the ledger to resumed.
      await stateMgr.saveRunState(run);

      // Strip the cockpit `ready` requeue label AFTER the durable save (mirrors the
      // l2-gate branch). The integrate park is decision-index-owned, but `ready`
      // aliases the daemon's NEW-work label — leaving it set lets detectReadyWork
      // reclaim this issue and start a DUPLICATE run if decision-owned detection is
      // ever unavailable or the body marker is stripped. Best-effort: a missing
      // label is fine; comments/markers are kept as audit + idempotency evidence.
      try {
        await runOctokit.issues.removeLabel({
          owner: runOwner,
          repo: runRepoName,
          issue_number: run.issueNumber,
          name: REQUEUE_LABEL,
        });
      } catch {
        /* label may not exist — ignore */
      }

      // CRASH-SAFE ORDERING (2/2): only AFTER the run-state requeue is committed
      // do we drive the ledger to terminal `resumed`.
      try {
        await decisionManager.ledger().advanceToResumed(decisionId, 'requeue');
      } catch (e) {
        console.warn(
          `[daemon] resumeParkedRuns: decision-index advanceToResumed failed for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Re-enter pipeline.
      await reenterPipeline(
        run,
        runOwner,
        runRepoName,
        resumeRepoId,
        runOctokit,
        phaseLabelMirror,
      );
    }

    async function reenterPipeline(
      run: RunState,
      runOwner: string,
      runRepoName: string,
      resumeRepoId: string,
      runOctokit: Octokit,
      phaseLabelMirror: ReturnType<typeof createPhaseLabelMirror>,
    ): Promise<void> {
      activeIssues.add(run.issueNumber);
      activeRuns++;
      run.deploymentId = config.deployment?.id;
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
      const handlers =
        run.variant === 'website'
          ? createWebsitePhaseHandlers(
              agencyConfig,
              null,
              notifyOctokit,
              runOwner,
              runRepoName,
              run.issueNumber,
              null,
            )
          : createPhaseHandlers(
              config,
              runOwner,
              runRepoName,
              runtime,
              coordinator,
              notifyOctokit,
              resumedRequest,
              stateDir,
              runWriter ?? undefined,
              run.id,
              repoRoot,
            configReader?.getRepoConfig(runOwner, runRepoName)?.activePlugins,
            knowledgeStore,
            phaseLabelMirror,
            decisionManager,
            undefined,
            deploymentRegistry,
          );
      const table = getPipeline(run.variant);

      runPipeline(
        run,
        table,
        handlers,
        stateMgr,
        costTracker,
        undefined,
        runWriter ?? undefined,
        phaseLabelMirror,
      )
        .then(async (result) => {
          console.log(
            `[daemon] Parked run #${run.issueNumber} finished: ${result.outcome}`,
          );
          void runWriter?.upsertRun(run.id, {
            outcome: toDbOutcome(result.outcome),
            completed_at: new Date().toISOString(),
            total_cost: run.cost,
          });
          if (result.outcome === 'stuck') {
            const stuckDetector = createWorkDetector(
              runOctokit,
              runOwner,
              runRepoName,
            );
            await stuckDetector.markStuck(
              run.issueNumber,
              result.error ?? 'Unknown error',
            );
          }
          handleRunOutcome(
            result.outcome,
            run.issueNumber,
            runOwner,
            runRepoName,
          );
        })
        .catch((e) =>
          console.error(`Parked run failed for #${run.issueNumber}:`, e),
        )
        .finally(() => {
          activeRuns--;
          activeIssues.delete(run.issueNumber);
          if (repoManager && resumeRepoId)
            repoManager.notifyRunEnd(resumeRepoId);
        });
    }
  }

  // 7. Drain mode + graceful shutdown
  const enterDrainMode = async () => {
    if (draining) return;
    draining = true;
    console.log(
      `[daemon] Entering drain mode — ${activeRuns} active run(s), waiting for completion`,
    );
    // Stop schedulers so no new background work starts
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
    if (knowledgeSyncPoller) clearInterval(knowledgeSyncPoller);
    stopHeartbeat();
    if (stopCoordinator) stopCoordinator();
    stopReviewScheduler();
    stopPOAgent?.();
    stopTechLeadScheduler?.();
    repoManager?.stop();
    configReader?.stop();
    await decisionManager.close();
    await postgresClient?.sql.end();
    await remoteControl.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log('[daemon] Instance lock released');
    console.log('Daemon stopped.');
  };

  // SIGTERM/SIGINT enter DRAIN mode — wait for active runs to finish, then exit.
  // This is the safe default; a long worker keeps running until it completes.
  process.on('SIGTERM', enterDrainMode);
  process.on('SIGINT', enterDrainMode);

  // SIGUSR2 is the operator FORCE-KILL path for a watched pilot: SIGKILL every
  // active worker process GROUP (the `claude`/`codex` child AND its tool
  // subprocesses) immediately, then exit the daemon. It does NOT drain. Use
  // `kill -USR2 <daemon_pid>` to stop everything within seconds. (Plain
  // `kill -9 <daemon_pid>` kills only the daemon and can orphan worker groups;
  // SIGUSR2 reaps the children first.)
  const forceKill = async () => {
    const killed = killAllManagedProcessGroups('SIGKILL');
    console.error(
      `[daemon] SIGUSR2 force-kill — SIGKILLed ${killed} active worker process group(s), exiting now (no drain)`,
    );
    // Best-effort release of the instance lock / control server before exit so a
    // restart can rebind the control port immediately. Do not await schedulers.
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      /* best-effort */
    }
    process.exit(1);
  };
  process.on('SIGUSR2', forceKill);

  return ok(undefined);
}

/**
 * Block until the Data Service recovers, polling `configReader.tryFetch()` at
 * `opts.intervalMs`. While blocked, the throwaway degraded server keeps
 * answering `/health`; no work is claimed (the work loop is wired only in the
 * post-block normal startup). Resolves on the first successful fetch.
 *
 * - Each unrecovered `unreachable` poll advances the escalation counter; at
 *   `opts.maxConsecutiveStuck` the Operator is notified once.
 * - A `rejected` poll (permanent misconfig) closes the degraded server, ends
 *   the DB client, and `process.exit(1)`s — startDaemon is awaiting and will
 *   not return.
 *
 * Exported (and `delay`/`intervalMs` injectable) so it is unit-testable.
 */
export async function runDegradedUntilRecovered(
  configReader: ConfigReader,
  degradedState: DegradedState,
  degradedHandle: DegradedServerHandle,
  postgresClient: { sql: { end: () => Promise<void> } },
  opts: {
    intervalMs: number;
    delay?: (ms: number) => Promise<void>;
    maxConsecutiveStuck: number;
    webhooks: string[];
  },
): Promise<void> {
  const delay =
    opts.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let consecutive = 0;
  let notified = false;
  for (;;) {
    await delay(opts.intervalMs);
    const r = await configReader.tryFetch();
    if (r.ok) return; // recovered → resolve
    degradedState.lastConfigError = r.error;
    const { code, message } = r.error.cause;
    if (r.error.category === 'rejected') {
      console.error(
        `[daemon] FATAL background config rejected: ${code ?? 'no-code'}: ${message}`,
      );
      await degradedHandle.close();
      await postgresClient.sql.end();
      process.exit(1);
    }
    consecutive += 1;
    console.log(
      `[daemon] startup config fetch failed (background, attempt ${consecutive}, unreachable, ${code ?? 'no-code'}): ${message}`,
    );
    if (consecutive >= opts.maxConsecutiveStuck && !notified) {
      void notify(opts.webhooks, {
        event: 'startup-degraded',
        issueNumber: 0,
        phase: 'startup',
        message: `Daemon startup-degraded: Data Service unreachable after ${consecutive} background attempts (${code ?? 'no-code'}: ${message})`,
      });
      notified = true;
    }
  }
}

function shouldPauseForRuntimeSource(status: RuntimeSourceStatus): boolean {
  return !status.healthy && status.action === 'pause';
}

async function releaseClaim(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const claimLabels = [
    'in-progress',
    'implementing',
    'l2-in-progress',
    'l3-in-progress',
    'l3-review',
  ];
  for (const label of claimLabels) {
    try {
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch {
      /* label may not exist */
    }
  }
}

async function preClassifyReadyWork(
  runtime: SessionRuntime,
  requests: WorkRequest[],
  batchClassifierConfig: BatchClassifierConfig,
): Promise<WorkRequest[]> {
  if (requests.length === 0) return requests;
  try {
    const result = await classifyBatch(
      runtime,
      requests.map((request) => ({
        issueNumber: request.issueNumber,
        workRequest: request,
      })),
      batchClassifierConfig,
    );
    const byIssue = new Map(
      result.results.map((item) => [item.issueNumber, item]),
    );
    return requests.map((request) => {
      const item = byIssue.get(request.issueNumber);
      if (!item) return request;
      return {
        ...request,
        preClassification: {
          event: item.event,
          complexity: item.complexity,
          changeKind: item.changeKind,
          scope: item.scope,
          allocatedCost: item.allocatedCost,
          batchSequenceId: result.batchSequenceId,
        },
      };
    });
  } catch (e) {
    console.warn(
      '[daemon] Batch classification failed before fallback completed — using per-run classify phase:',
      e,
    );
    return requests;
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
  runWriter?: RunWriter,
  configReader?: ConfigReader,
  runHistory?: RunHistoryReader,
  repoRoot?: string,
  knowledgeStore?: KnowledgeStore,
  repoManager?: RepoManager | null,
  decisionManager?: DecisionIndexManager,
  registry?: DeploymentRegistry,
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
    deploymentId: config.deployment?.id,
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
    active_plugins: repoConfig?.activePlugins.map((p) => p.id) ?? [],
  });

  // Per-issue retry cap (DB mode only) — auto-block issues that have gone stuck too many times
  if (runWriter && runHistory) {
    const count = await runHistory.countStuckRunsForIssue({
      repoOwner: owner,
      repoName,
      issueNumber: request.issueNumber,
    });
    if (count !== null) {
      if (count >= config.maxRunsPerIssue) {
        console.warn(
          `[daemon] Issue #${request.issueNumber} hit retry cap (${count} stuck runs) — auto-blocking`,
        );
        const capOctokit = new Octokit({
          auth: repoManager
            ? await repoManager.resolveTokenForRepo(repoId)
            : process.env.GITHUB_TOKEN,
        });
        await capOctokit.issues.addLabels({
          owner,
          repo: repoName,
          issue_number: request.issueNumber,
          labels: ['blocked'],
        });
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
  const resolvedToken = repoManager
    ? await repoManager.resolveTokenForRepo(repoId)
    : process.env.GITHUB_TOKEN;
  const notifyOctokit = new Octokit({ auth: resolvedToken });
  const phaseLabelMirror = createPhaseLabelMirror(
    notifyOctokit,
    owner,
    repoName,
  );
  const agencyConfig = await readAgencyConfig(null, '');
  const handlers =
    variant === 'website'
      ? createWebsitePhaseHandlers(
          agencyConfig,
          null, // config store — wired in follow-on
          notifyOctokit,
          owner,
          repoName,
          request.issueNumber,
          null, // repoId — wired in follow-on
        )
      : createPhaseHandlers(
          config,
          owner,
          repoName,
          runtime,
          coordinator,
          notifyOctokit,
          request,
          stateDir,
          runWriter ?? undefined,
          run.id,
          repoRoot,
          repoConfig?.activePlugins,
          knowledgeStore,
          phaseLabelMirror,
          decisionManager,
          undefined,
          registry,
        );
  const table = getPipeline(variant);

  console.log(
    `[daemon] Pipeline start for #${request.issueNumber}: ${request.title}`,
  );
  const result = await runPipeline(
    run,
    table,
    handlers,
    stateMgr,
    costTracker,
    undefined,
    runWriter ?? undefined,
    phaseLabelMirror,
  );
  console.log(
    `[daemon] Pipeline done for #${request.issueNumber}: ${result.outcome}${result.error !== undefined && result.error !== '' ? ` — ${result.error}` : ''}`,
  );

  void runWriter?.upsertRun(run.id, {
    outcome: toDbOutcome(result.outcome),
    completed_at: new Date().toISOString(),
    report: run.report ?? null,
    total_cost: run.cost,
    fix_attempts: run.fixAttempts.length,
    active_plugins: repoConfig?.activePlugins.map((p) => p.id) ?? [],
  });

  if (result.outcome === 'stuck') {
    await detector.markStuck(
      request.issueNumber,
      result.error ?? 'Unknown error',
    );
    await notify(config.webhooks, {
      event: 'stuck',
      issueNumber: request.issueNumber,
      phase: run.phase,
      message: `Issue #${request.issueNumber} stuck: ${result.error ?? 'unknown'}`,
    });
  }

  return result.outcome;
}
