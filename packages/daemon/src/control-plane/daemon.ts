// src/control-plane/daemon.ts
import { isIP } from 'node:net';
import { Octokit } from '@octokit/rest';
import {
  loadConfig,
  validateRequiredBootEnv,
  hasConfiguredAlertChannel,
  type Config,
} from '../config.js';
import { SessionRuntime } from '../session-runtime/runtime.js';
import { CostTracker } from '../session-runtime/cost.js';
import { createProviderAdapter } from '../session-runtime/adapters/index.js';
import type { ProviderAdapter } from '../session-runtime/adapters/index.js';
import { DEFAULT_POLICY } from '../session-runtime/containment-hooks.js';
import {
  admitProviders,
  buildCriticalChainByTier,
  type ProviderAdmissionBinding,
} from '../session-runtime/providers/startup-admission.js';
import { smokeTest, type SmokeProof } from '../session-runtime/providers/smoke-test.js';
import {
  killAllManagedProcessGroups,
  terminateAllManagedProcessGroups,
} from '../session-runtime/managed-processes.js';
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
import { retryStuckIssue } from './operator-retry.js';
import { createPhaseHandlers } from './phases.js';
import {
  createDeploymentRegistry,
  JsonFileAutonomyStore,
  type DeploymentRegistry,
} from './deployment-registry/index.js';
import type { RiskClass, AutonomyLevel } from './deployment-registry/types.js';
import {
  buildSanitizationPipelineForDeployment,
} from './sanitization/build-pipeline.js';
import { ensureWorkspaceRepo } from './workspace-bootstrap.js';
import {
  DecisionIndexManager,
  markRuntimeDegradedIfGoverned,
  clearRuntimeDegradedIfGoverned,
} from './decision-escalation/manager.js';
import type { ProtectedStore } from '@auto-claude/sanitizer-redaction';
import { readDecisionIndexConfig } from './decision-escalation/config.js';
import { decisionIdFor } from './decision-escalation/build-request.js';
import { decisionIdFor as mergeDecisionIdFor } from './merge-decision/build-request.js';
import {
  bootReconcile,
  supersedeIfMoot,
  markOverdue,
} from './decision-escalation/reconcile.js';
import {
  listPendingDecisions,
  getDecisionDetail,
  answerDecision,
  revealProtected,
} from './decision-api.js';
import { postDecisionResponse } from './decision-escalation/answer-publisher.js';
import { runFindingDismissalTick } from './finding-dismissal/tick.js';
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
import { notify, type NotificationPayload } from './notify.js';
import {
  createWatchdog,
  readActiveRunProgress,
  type WatchdogStall,
  type WatchdogSignals,
} from './watchdog.js';
import {
  evaluateHealth,
  type PauseReason,
  type HealthSignals,
} from './health.js';
import { createCrashHandlers } from './crash-handlers.js';
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
import { OperatorLearningService } from '../operator-learning/index.js';
import { startKnowledgeMaintenance } from '../knowledge/maintenance.js';
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
import { fetchUntriagedIssues } from '../coordination/tech-lead/triage.js';
import { applyTriageDecisions } from '../coordination/tech-lead/finding-triage.js';
import { TriageStore } from '../coordination/tech-lead/triage-store.js';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';
import { mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import type { Proposal, IdeaSubmission } from '../coordination/types.js';
import {
  buildProductOwnerSessionVariables,
  buildProductOwnerSignalSnapshot,
  PRODUCT_OWNER_SNAPSHOT_CONFIG,
} from './po-snapshot.js';
import { SharedPOStateStore } from '../coordination/product-owner/shared-po-state.js';
import {
  hasActiveInteractiveSession,
  closeOrphanedSessions,
  startInteractivePOSession,
} from '../coordination/product-owner/interactive-session-context.js';

// Daily run-count state. Held in one resettable object rather than bare module-level
// `let`s so tests can reset it with __resetDailyRunStateForTests() instead of
// vi.resetModules()+re-importing the whole daemon.js graph per test. That cold
// re-import is what flaked CI under shared-runner contention (RC-3, #770): with a
// resettable holder, daemon.test.ts imports daemon.js once (warm) and resets state
// via a call. Production behavior is unchanged — the daily run-count limit still
// resets at the UTC date boundary in beginRun() below.
const dailyRunState: { count: number; resetDate: string } = {
  count: 0,
  resetDate: new Date().toISOString().split('T')[0]!,
};

/**
 * Test-only: reset the daily run-count state to a clean slate. Exported solely so
 * daemon.test.ts's loadDaemon() can drop vi.resetModules() (RC-3) — it is NOT part
 * of the daemon's runtime contract and must not be called from production code.
 */
export function __resetDailyRunStateForTests(): void {
  dailyRunState.count = 0;
  dailyRunState.resetDate = new Date().toISOString().split('T')[0]!;
}

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
  /**
   * B5 work-loop watchdog test seam (first-use safety net). Injects a clock,
   * tick cadence, idle-timeout, and optionally the live-signal reader so the
   * detect→self-pause path is deterministic under fake timers. Production uses
   * wall-clock + the real activeRunProgress/pollerSnapshot readers.
   */
  watchdog?: {
    now?: () => number;
    intervalMs?: number;
    idleTimeoutMs?: number;
    readSignals?: () => Promise<WatchdogSignals>;
  };
}

// B5 watchdog default idle-timeout: the 3h subprocess-kill bound + 15m grace.
// Chosen so a long-but-PROGRESSING in-worker phase (capped at 3h) never
// false-positives, while an orchestration-level untimed await is caught after the
// threshold. Configurable downward via config.watchdogIdleTimeoutMs for pilots.
const DEFAULT_WATCHDOG_IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000 + 15 * 60 * 1000;

/**
 * Resolve the gate issue's repo coordinates from a decision's `source_url`
 * (`https://github.com/<owner>/<repo>/issues/<n>`), or `null` when it is not a
 * recognizable GitHub issue URL. The DecisionResponse must be posted to the
 * decision's OWN repo (not the seed `config.repo`): `resumeParkedRuns` polls the
 * run's repo, so a multi-repo deployment answering an imported repo's decision
 * must target that repo's issue or the answer is never observed.
 */
function repoCoordsFromSourceUrl(
  sourceUrl: string,
): { owner: string; repo: string; issueNumber: number } | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#]|$)/.exec(sourceUrl);
  if (m === null) return null;
  const n = Number(m[3]);
  if (!Number.isInteger(n)) return null;
  return { owner: m[1]!, repo: m[2]!, issueNumber: n };
}

export async function startDaemon(
  configPath: string,
  opts?: StartDaemonOptions,
): Promise<Result<void>> {
  // 0. Validate required boot environment variables up front.
  const envCheck = validateRequiredBootEnv();
  if (!envCheck.ok) {
    return err(new Error('Missing required environment variables: ' + envCheck.missing.join(', ')));
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

  // The protected store is required when a deployment profile activates the
  // withholding sanitizer. A disabled or broken index yields undefined here;
  // build-pipeline fails closed if withholding is configured without a store.
  let protectedStore: ProtectedStore | undefined;
  try {
    protectedStore = decisionManager.protectedStore();
  } catch {
    protectedStore = undefined;
  }

  // 2c. Deployment registry (optional, flag-gated). A malformed deployment
  // profile is rejected at registration; the registry is left empty so the
  // integrate handler falls back to its flag-OFF unconditional merge.
  // Autonomy state is durable: an explicit Operator grant survives restart.
  const deploymentRegistry = createDeploymentRegistry({
    autonomyStore: new JsonFileAutonomyStore(join(stateDir, 'autonomy.json')),
  });
  if (config.deployment !== undefined) {
    const registered = deploymentRegistry.register(
      config.deployment.id,
      config.deployment.profile,
    );
    // A1 boot guard (i): a configured (merge-governed) deployment whose profile is
    // REJECTED has no governance surface at all. Refuse boot (fail closed) instead
    // of running with an empty registry that surfaces the rejection only later, at
    // integrate. The message names the offenders so the operator can fix the profile.
    if (!registered.ok) {
      return err(
        new Error(
          `[daemon] Deployment registration failed for "${config.deployment.id}" — ` +
            `refusing boot for a configured deployment (fix the profile): ${registered.offenders.join('; ')}`,
        ),
      );
    }
    // A1 boot guard (ii): a merge-governed deployment REQUIRES an available decision
    // index — escalate/hold/compliance merge decisions must reach the Operator, and
    // the index is the only transport for that. When the approval surface is dead we
    // refuse boot rather than convert every required park into a silent runtime
    // failure. Distinguish DISABLED (set the flag) from ENABLED-BUT-UNREACHABLE so
    // the underlying cause is operator-observable (FUNC-AC-SAFETY).
    if (!decisionManager.isAvailable()) {
      if (!decisionManager.isEnabled()) {
        return err(
          new Error(
            `[daemon] Refusing boot for configured deployment "${config.deployment.id}": the ` +
              `decision index is DISABLED, but a merge-governed deployment requires it to ` +
              `surface escalate/hold merge decisions for Operator approval. Set ` +
              `AUTO_CLAUDE_DECISION_INDEX_ENABLED=1 (and AUTO_CLAUDE_DATABASE_URL) to enable ` +
              `it, or remove the deployment profile to run ungoverned.`,
          ),
        );
      }
      return err(
        new Error(
          `[daemon] Refusing boot for configured deployment "${config.deployment.id}": the ` +
            `decision index is enabled but unreachable — the approval surface is dead, so ` +
            `escalate/hold merge decisions cannot reach the Operator. Check ` +
            `AUTO_CLAUDE_DATABASE_URL / Postgres connectivity for the decision index.`,
        ),
      );
    }
  }

  // B2 (first-use safety net, Codex CRITICAL 1): a GOVERNED deployment with no
  // configured alert channel boots with a LOUD warning and is reported
  // `degraded:true` by /health — but is NOT refused. Existing L1 mandates "don't
  // run silently" + "make degraded state observable" (which warn + degraded fully
  // satisfy); no L1 makes an alert channel *required* (that hard-refuse is the
  // deferred B2-strict, an Operator L1 decision). Non-governed local runs are
  // unaffected. The flag is read by /health (T2.6) and surfaced on /status.
  const alertChannelDegraded =
    config.deployment !== undefined && !hasConfiguredAlertChannel(config);
  if (alertChannelDegraded) {
    console.warn(
      `[daemon] WARNING: governed deployment "${config.deployment!.id}" has NO configured ` +
        `alert channel (webhooks is empty). Auto-pause / escalation / crash alerts will NOT ` +
        `reach the Operator — the daemon will report /health degraded:true. Configure at ` +
        `least one webhook (and an external /health monitor) for unattended operation.`,
    );
  }

  // 2d. Input-boundary sanitization pipeline (default = identity). Built once
  // from the active deployment profile; omitted or empty bindings keep the
  // decision-raise path byte-identical to today. A profile that activates a
  // sanitizer whose prerequisite is unavailable (e.g. withholding without a
  // protected store because the decision index is disabled) throws here; fail
  // CLOSED via the Result rather than letting an unhandled throw abort boot.
  let sanitizationPipeline: ReturnType<typeof buildSanitizationPipelineForDeployment>;
  try {
    sanitizationPipeline = buildSanitizationPipelineForDeployment(
      deploymentRegistry,
      config.deployment?.id,
      { protectedStore },
    );
  } catch (e) {
    return err(
      new Error(
        `[daemon] Failed to build the input-boundary sanitization pipeline ` +
          `(a deployment activates a sanitizer whose prerequisite is unavailable — ` +
          `e.g. withholding requires the decision index / protected store): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      ),
    );
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
      // Sanitize the provider name into the temp-dir prefix: provider names are
      // validated only as non-empty, so a name with a path separator would turn
      // the prefix into a nested path and make mkdtemp throw ENOENT before the
      // proof could be recorded. Keep only filename-safe chars (codex).
      const safeName = provider.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const workspace = await mkdtemp(join(tmpdir(), `smoke-${safeName}-`));
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

    // One binding per (provider, tier) — the granularity the registry gates
    // resolve() on. The proven model is the provider's declared `model` (else the
    // tier label). NOTE (scoped limitation): per-role `roleModels.<role>.model`
    // overrides within a tier are NOT individually proven — the smoke gate is
    // per-(provider,tier), not per-model. Proving role-specific model bindings is a
    // separate enhancement to the gate's granularity (registry + smoke key), not
    // this startup-wiring task; it still proves strictly more than the gate-off
    // default (which proves nothing).
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

    // Unbound work resolves through defaultProvider then the fallback chain, and
    // resolution is per-(provider,tier). Build the tier-keyed critical path so
    // admission keeps EVERY tier any chain provider serves usable (incl.
    // fallback-only tiers — an unbound request for one still resolves here).
    const chainNames = [
      config.providers.defaultProvider,
      ...config.providers.fallbackChain,
    ];
    const criticalChainByTier = buildCriticalChainByTier(
      config.providers.definitions,
      chainNames,
    );

    const admission = await admitProviders({
      registry,
      providers,
      requireSmokeProof: true,
      runSmoke,
      criticalChainByTier,
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
  const operatorLearning = new OperatorLearningService({
    logPath: join(stateDir, 'operator-learning.jsonl'),
    proposalDir: join(stateDir, 'operator-learning-proposals'),
  });
  await operatorLearning.init();
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

  // 3b-2. Start institutional-learning maintenance (detect systemic proposals,
  // surface promotion candidates). Opt-in via config; default off.
  const knowledgeMaintenance = startKnowledgeMaintenance(knowledgeStore, stateDir, {
    enabled: config.knowledgeMaintenance?.enabled === true,
    intervalMs:
      config.knowledgeMaintenance?.intervalMinutes !== undefined &&
      config.knowledgeMaintenance.intervalMinutes > 0
        ? config.knowledgeMaintenance.intervalMinutes * 60_000
        : 60 * 60_000,
    systemicProposalThreshold: config.knowledgeMaintenance?.systemicProposalThreshold ?? 3,
    promotionCooldownDays: config.knowledgeMaintenance?.promotionCooldownDays ?? 30,
  });

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
  const poInteractiveSessionsDir = join(poStateDir, 'sessions');
  await mkdir(poInteractiveSessionsDir, { recursive: true });
  const poSharedStatePath = join(poStateDir, 'shared-po-state.json');
  const poStateStore = new SharedPOStateStore(
    poSharedStatePath,
    config.coordination.poMaxWriteRetries,
  );
  await closeOrphanedSessions(poInteractiveSessionsDir);
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
      shouldDeferCycle: async () =>
        hasActiveInteractiveSession(poInteractiveSessionsDir),
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
  await mkdir(join(techLeadStateDir, 'triage'), { recursive: true });

  const techProposalStore = new TechProposalStore(
    techLeadProposalsDir,
    techLeadEnrichmentsDir,
  );
  await techProposalStore.init();

  const triageStore = new TriageStore(
    join(techLeadStateDir, 'triage', 'triage-state.json'),
  );

  const techLeadScheduler = createTechLeadScheduler(
    {
      assembleDigest: async (trigger, cfg, triageContext) => {
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
            untriagedIssues: triageContext.untriagedIssues,
            triageRemainingCap: triageContext.remainingCap,
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
      fetchUntriagedIssues: async (cap) => {
        if (!config.repo) return [];
        return fetchUntriagedIssues(
          {
            octokit: new Octokit({ auth: process.env.GITHUB_TOKEN }),
            owner: config.repo.owner,
            repo: config.repo.name,
          },
          cap,
        );
      },
      getTriageRemainingCap: async () =>
        triageStore.remaining(config.coordination.triageDailyCap),
      applyTriageDecisions: async (decisions, remainingCap) => {
        if (!config.repo) {
          return { applied: 0, skipped: decisions.length, capReached: false };
        }
        return applyTriageDecisions(
          decisions,
          {
            octokit: new Octokit({ auth: process.env.GITHUB_TOKEN }),
            owner: config.repo.owner,
            repo: config.repo.name,
            onCapConsumed: () => {
              triageStore.increment(1).catch((e) => {
                console.warn(
                  `[tech-lead-scheduler] failed to update triage cap: ${e instanceof Error ? e.message : String(e)}`,
                );
              });
            },
          },
          remainingCap,
        );
      },
    },
    {
      intervalMs: config.coordination.techLeadInterval,
      eventDebounceMs: config.coordination.techLeadEventDebounce,
      proposalExpiryMs: config.coordination.techLeadProposalExpiryMs,
      lookbackWindowMs: config.coordination.techLeadLookbackWindowMs,
      maxEntriesPerSection: config.coordination.techLeadMaxEntriesPerSection,
      triageDailyCap: config.coordination.triageDailyCap,
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
        git: async (_args: string[], _cwd?: string) => ok('' as string),
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
            pauseReason = 'tick-error';
            console.warn(
              `[daemon] Auto-paused: coordinator hit ${consecutiveErrors} consecutive tick errors`,
            );
            notifyOperator({
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
  // pauseReason (first-use safety net, T2.1): WHY the daemon is paused, stamped at
  // every set-paused site so /health can distinguish an intentional MANUAL pause
  // (200 degraded) from a SAFETY pause (503). An un-tagged pause defaults to the
  // cautious safety interpretation downstream. The initial pause (if any) is the
  // runtime-source preflight.
  let pauseReason: PauseReason | null = paused ? 'runtime-source' : null;
  // P0.5 operator-halt state: true while /halt is actively waiting for in-flight
  // runs to park. Guards runPipeline so killed-worker failures self-looping the
  // FSM park instead of retrying/advancing. Once set, it stays latched until
  // /resume clears it; the bounded wait only measures response latency, it does
  // not weaken the interlock.
  let halting = false;
  // B5 watchdog detection state (null = no stall) — surfaced on /status and
  // mapped to /health 503.
  let watchdogStall: WatchdogStall | null = null;
  // B5 watchdog clock + idle-timeout (injectable for deterministic tests). The
  // idle-timeout prefers an explicit test override, then config, then the default
  // (3h subprocess bound + 15m grace).
  const watchdogNow = opts?.watchdog?.now ?? ((): number => Date.now());
  // The test seam (opts.watchdog.idleTimeoutMs) is unclamped for deterministic
  // fake-timer tests. The CONFIG override is clamped to the default ceiling: the
  // knob is configurable DOWNWARD only (tighten for pilots) — an upward override
  // would silently weaken the safety net, so it can never raise the timeout.
  const watchdogIdleTimeoutMs =
    opts?.watchdog?.idleTimeoutMs ??
    Math.min(
      config.watchdogIdleTimeoutMs ?? DEFAULT_WATCHDOG_IDLE_TIMEOUT_MS,
      DEFAULT_WATCHDOG_IDLE_TIMEOUT_MS,
    );
  // B1/B4: whether the most recent operator alert send failed transiently
  // (reported as /health 200-degraded). Reset on the next successful send.
  let lastAlertSendFailed = false;
  let draining = false;
  let activeRuns = 0;
  let shuttingDown = false;
  let consecutiveStuckCount = 0;

  // Resolves when shutdown() has ACTUALLY completed all its cleanup. The crash
  // handler (T2.7) awaits this so a fatal crash during an active run waits for a
  // clean graceful shutdown (NOT the immediate-return enterDrainMode flag-flip) —
  // while a wedged run that never settles leaves this pending so the crash
  // handler's bounded force-exit timer performs the exit.
  let resolveShutdownComplete!: () => void;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdownComplete = resolve;
  });

  // Decrement the active-run count when a run settles, and — crucially — complete
  // a graceful drain HERE (after the decrement). handleRunOutcome's drain check
  // runs in the run promise's `.then`, BEFORE this `.finally` decrement, so for
  // the final in-flight run it sees activeRuns>0 and never fires; this post-
  // decrement trigger is what actually finishes the drain (and resolves
  // shutdownComplete for the crash handler).
  function finishActiveRun(): void {
    activeRuns--;
    if (draining && activeRuns === 0 && !shuttingDown) {
      console.log('[daemon] Drain complete — all runs finished, shutting down');
      void shutdown();
    }
  }

  // B1 (first-use safety net): a single operator-alert entry point that makes the
  // empty-channel case NON-SILENT. notify() with zero webhooks is a silent no-op;
  // here, when no channel is configured, we emit a structured console.warn so an
  // auto-pause / escalation / crash never disappears into the void. SSRF behavior
  // is unchanged (notify() still validates each URL).
  function notifyOperator(payload: NotificationPayload): void {
    if (!hasConfiguredAlertChannel(config)) {
      console.warn(
        `[daemon] ALERT NOT DELIVERED (no alert channel configured): ${payload.event} — ${payload.message}`,
      );
      return;
    }
    void notify(config.webhooks, payload)
      .then((result) => {
        lastAlertSendFailed = result.failedUrls.length > 0;
      })
      .catch(() => {
        lastAlertSendFailed = true;
      });
  }
  // Synchronous in-process guard for the single-session interactive PO launch.
  // The fs marker (the session record) is written only AFTER async context
  // assembly, so two concurrent launches can both pass hasActiveInteractiveSession()
  // before either marker exists. This flag is set/checked synchronously (no await
  // in between) so the second concurrent launch is rejected; it is cleared in a
  // finally so a failed launch never wedges the gate. The fs check still covers
  // cross-process / post-restart cases.
  let interactiveSessionLaunching = false;
  const activeIssues = new Set<number>(); // Persists across poll cycles — prevents duplicate runs

  // gap #6 — detect dispatch serialization. Daemon-scoped, repo-keyed registry of
  // repos with a detect phase currently in flight (entry phase === 'detect').
  // A run is gated BEFORE it is claimed/committed (so an already-claimed in-progress
  // run is never stranded) and released the moment detect SETTLES (release-before-
  // signal in phases.ts) — preserving post-detect concurrency. Covers ALL in-process
  // detect entrants: fresh-work claim loops AND crash-resumption (FIFO-deferred,
  // never skip-and-dropped). website/non-detect/parked-resume entrants bypass it.
  const detectInFlight = new Set<string>();

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
    pauseReason = 'runtime-source';
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
        pauseReason = 'budget';
        console.warn(
          `[daemon] Auto-paused: daily budget exceeded (issue #${issueNumber})`,
        );
        notifyOperator({
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
        pauseReason = 'stuck';
        console.warn(
          `[daemon] Auto-paused: ${consecutiveStuckCount} consecutive stuck runs reached threshold`,
        );
        notifyOperator({
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
            // Governed-only marking: a per-tick reconcile failure means the
            // decision index (Postgres) is unreachable at runtime, degrading the
            // whole approval surface for this configured deployment.
            markRuntimeDegradedIfGoverned(
              decisionManager,
              config.deployment?.id,
              e instanceof Error ? e.message : String(e),
            );
            console.error('[daemon] tick reconcile error:', e);
          }
          // Overdue marking: mark past-expiry notified/viewed decisions stale
          // (mark only — no delivery). markOverdue never throws.
          try {
            await markOverdue(decisionManager.ledger(), new Date());
          } catch (e) {
            markRuntimeDegradedIfGoverned(
              decisionManager,
              config.deployment?.id,
              e instanceof Error ? e.message : String(e),
            );
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
        // gap #6: repo key for the detect dispatch gate (one repo per poll callback).
        const detectRepoKey = `${owner}/${name}`;
        // Per-tick carrier of each committed run's idempotent detect-gate release,
        // created at the claim/commit point and threaded into the dispatch site.
        const detectGateReleases = new Map<number, () => void>();
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
          // gap #6: detect dispatch gate, checked BEFORE claimWork so we never
          // strand an already-claimed in-progress issue. A run whose ENTRY phase is
          // detect is skipped this tick (retried next tick) while another detect is
          // in flight for the same repo.
          const entersAtDetect =
            getStartPhase(selectVariant(request)) === 'detect';
          if (entersAtDetect && detectInFlight.has(detectRepoKey)) continue;
          const claimResult = await detector.claimWork(request.issueNumber);
          if (!claimResult.ok) continue;
          claimedIssues.add(request.issueNumber);
          activeIssues.add(request.issueNumber);
          activeRuns++;
          repoManager!.notifyRunStart(repoId);
          // Commit point: mark the repo's detect gate held and build the per-run
          // idempotent release (carried to the dispatch site below).
          if (entersAtDetect) detectInFlight.add(detectRepoKey);
          let gateReleased = false;
          const releaseDetectGateOnce = (): void => {
            if (gateReleased) return;
            gateReleased = true;
            if (entersAtDetect) detectInFlight.delete(detectRepoKey);
          };
          detectGateReleases.set(request.issueNumber, releaseDetectGateOnce);
          readyToProcess.push(request);
        }
        const preClassifiedReady = await preClassifyReadyWork(
          runtime,
          readyToProcess,
          batchClassifierConfig,
        );
        for (const request of preClassifiedReady) {
          const releaseDetectGateOnce = detectGateReleases.get(
            request.issueNumber,
          );
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
            protectedStore,
            releaseDetectGateOnce,
            () => halting,
            () => paused,
          )
            .then((outcome) =>
              handleRunOutcome(outcome, request.issueNumber, owner, name),
            )
            .catch((e) =>
              console.error(`Run failed for #${request.issueNumber}:`, e),
            )
            .finally(() => {
              finishActiveRun();
              activeIssues.delete(request.issueNumber);
              repoManager!.notifyRunEnd(repoId);
              // gap #6 setup-throw backstop: a throw in processWorkRequest's
              // pre-detect setup rejects the promise before detect's EARLY release
              // fires, so free the gate here too. Idempotent — a no-op once detect
              // already released.
              releaseDetectGateOnce?.();
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
          // gap #6: detect dispatch gate (checked before claim — no stranded claim).
          const bugEntersAtDetect =
            getStartPhase(selectVariant(bugRequest)) === 'detect';
          if (!(bugEntersAtDetect && detectInFlight.has(detectRepoKey))) {
            const bugClaimResult = await detector.claimBugFixWork(
              bugRequest.issueNumber,
            );
            if (bugClaimResult.ok) {
              claimedIssues.add(bugRequest.issueNumber);
              activeIssues.add(bugRequest.issueNumber);
              activeRuns++;
              repoManager!.notifyRunStart(repoId);
              if (bugEntersAtDetect) detectInFlight.add(detectRepoKey);
              let bugGateReleased = false;
              const releaseBugDetectGateOnce = (): void => {
                if (bugGateReleased) return;
                bugGateReleased = true;
                if (bugEntersAtDetect) detectInFlight.delete(detectRepoKey);
              };
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
                protectedStore,
                releaseBugDetectGateOnce,
                () => halting,
                () => paused,
              )
                .then((outcome) =>
                  handleRunOutcome(
                    outcome,
                    bugRequest.issueNumber,
                    owner,
                    name,
                  ),
                )
                .catch((e) =>
                  console.error(`Run failed for #${bugRequest.issueNumber}:`, e),
                )
                .finally(() => {
                  finishActiveRun();
                  activeIssues.delete(bugRequest.issueNumber);
                  repoManager!.notifyRunEnd(repoId);
                  releaseBugDetectGateOnce();
                });
            }
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
          // gap #6: detect dispatch gate (checked before claim — no stranded claim).
          const fpEntersAtDetect =
            getStartPhase(selectVariant(fpRequest)) === 'detect';
          if (!(fpEntersAtDetect && detectInFlight.has(detectRepoKey))) {
            const fpClaimResult = await detector.claimFeaturePipelineWork(
              fpRequest.issueNumber,
              fpRequest.workType as FeaturePipelineWorkType,
            );
            if (fpClaimResult.ok) {
              activeIssues.add(fpRequest.issueNumber);
              activeRuns++;
              repoManager!.notifyRunStart(repoId);
              if (fpEntersAtDetect) detectInFlight.add(detectRepoKey);
              let fpGateReleased = false;
              const releaseFpDetectGateOnce = (): void => {
                if (fpGateReleased) return;
                fpGateReleased = true;
                if (fpEntersAtDetect) detectInFlight.delete(detectRepoKey);
              };
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
                protectedStore,
                releaseFpDetectGateOnce,
                () => halting,
                () => paused,
              )
                .then((outcome) =>
                  handleRunOutcome(outcome, fpRequest.issueNumber, owner, name),
                )
                .catch((e) =>
                  console.error(`Run failed for #${fpRequest.issueNumber}:`, e),
                )
                .finally(() => {
                  finishActiveRun();
                  activeIssues.delete(fpRequest.issueNumber);
                  repoManager!.notifyRunEnd(repoId);
                  releaseFpDetectGateOnce();
                });
            }
          }
        }

        // Parked-run resume scan — after all normal work detection (mirrors legacy poller)
        await resumeParkedRuns().catch((e) =>
          console.error('[daemon] resumeParkedRuns error:', e),
        );

        // Finding-dismissal decision flow (PR1) — a SIBLING scan beside
        // resumeParkedRuns (NOT inside it: a finding is an issue, not a parked
        // run). Gated on an available decision index. The tick gates EMIT on a
        // non-empty allowlist (the per-deployment opt-in), but ALWAYS runs the
        // apply-consumer so answered decisions never dangle if the allowlist is
        // later emptied (a cheap no-op scan when there are no finding rows). Fully
        // fail-safe.
        const findingAllowlist = config.operatorReviewCategories ?? [];
        if (decisionManager.isAvailable()) {
          try {
            const fdToken = repoManager
              ? await repoManager.resolveTokenForRepo(repoId)
              : process.env.GITHUB_TOKEN;
            await runFindingDismissalTick({
              ledger: decisionManager.ledger(),
              octokit: new Octokit({ auth: fdToken }),
              operatorLearning,
              owner,
              repo: name,
              allowlist: findingAllowlist,
            });
          } catch (e) {
            console.error('[daemon] finding-dismissal tick error:', e);
          }
        }
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
        const state = remoteControl.getState() ?? {};
        const { remote_control_url: _discarded, ...safeState } = state;
        void _discarded;
        return {
          activeRuns,
          activeIssues: [...activeIssues],
          dailyRunCount: dailyRunState.count,
          dailyCost: costTracker.getDailyCost(),
          paused,
          // T2.1: WHY the daemon is paused (manual vs safety) — drives /health.
          pauseReason,
          draining,
          consecutiveStuckCount,
          uptime: process.uptime(),
          runtimeSource: runtimeSourceStatus,
          // First-use PR1: surface the governed decision-index health on /status.
          // `isGoverned` = a deployment profile is configured (the merge-governance
          // boundary); `isRuntimeDegraded` = a governed approval-path op failed at
          // runtime. Both are observability-only here; /health maps them to 503.
          isGoverned: config.deployment !== undefined,
          isRuntimeDegraded: decisionManager.isRuntimeDegraded(),
          // B2/B5 first-use safety net: governed-without-channel + watchdog state.
          alertChannelDegraded,
          watchdogStall,
          ...safeState,
        };
      },
      // B4 (first-use safety net, T2.6): the FULL truthful /health mapping. The
      // daemon gathers a HealthSignals snapshot from its live state and delegates
      // the 503 / 200-degraded / 200-ok decision to the pure evaluateHealth (the
      // status-code matrix is unit-tested there). Extends PR1's minimal governed
      // decision-index signal; a non-governed daemon's index state is never a
      // health signal (legacy integrate is normal there).
      getHealth: () => {
        const snaps = repoManager?.pollerSnapshot() ?? [];
        const now = watchdogNow();
        // An on-demand read of the SAME tick-stall condition the watchdog records
        // (it just lets /health report 503 immediately, before the watchdog's next
        // interval tick). It MUST use the watchdog idle-timeout, not an earlier
        // threshold: a poll legitimately awaits a long-but-bounded classifier run
        // (preClassifyReadyWork, 3h subprocess cap), so an earlier threshold would
        // false-503 a healthy long poll. Aligned with the watchdog so the two
        // signals can never disagree.
        const repoTickStale = snaps.some(
          (s) =>
            s.pollInProgress &&
            s.pollStartedAt !== null &&
            now - s.pollStartedAt > watchdogIdleTimeoutMs,
        );
        const signals: HealthSignals = {
          isGoverned: config.deployment !== undefined,
          indexRuntimeDegraded: decisionManager.isRuntimeDegraded(),
          indexEnabledButUnavailable:
            decisionManager.isEnabled() && !decisionManager.isAvailable(),
          paused,
          pauseReason,
          draining,
          consecutiveStuckCount,
          maxConsecutiveStuck: config.maxConsecutiveStuck,
          watchdogStalled: watchdogStall !== null,
          repoTickStale,
          startupDegradedRetrying: configReader?.isStartupDegraded() ?? false,
          alertChannelDegraded,
          transientAlertFailure: lastAlertSendFailed,
        };
        return evaluateHealth(signals);
      },
      pause: () => {
        // Operator/manual pause — intentional, reported as /health 200-degraded.
        paused = true;
        pauseReason = 'manual';
      },
      halt: async () => {
        // P0.5 operator emergency halt. Set paused + halting, terminate workers
        // with SIGTERM→SIGKILL escalation, then wait (bounded) for in-flight
        // runPipeline loops to park themselves via the halt interlock. Both
        // `paused` and `halting` stay latched until a successful /resume.
        paused = true;
        pauseReason = 'halt';
        if (halting) {
          // Idempotent: already halting, just report current parked state.
          const parkedRuns = await stateMgr.findParkedRuns();
          return {
            halted: true,
            parked: parkedRuns
              .filter((r) => r.parkedBy === 'halt')
              .map((r) => r.issueNumber),
            terminated: 0,
            escalated: 0,
          };
        }
        halting = true;

        let terminated = 0;
        let escalated = 0;
        try {
          const termination = await terminateAllManagedProcessGroups({
            graceMs: 5000,
          });
          terminated = termination.terminated;
          escalated = termination.escalated;
        } catch (e) {
          console.error('[daemon] /halt worker termination failed:', e);
        }

        // Bounded wait for in-flight runs to park. The interlock parks on the
        // next handler return/catch; killing the worker forces that return.
        // `halting` stays latched so a late-settling run still parks instead of
        // resuming normal routing. Only /resume clears it.
        const haltStart = Date.now();
        const haltTimeoutMs = 15_000;
        while (activeRuns > 0 && Date.now() - haltStart < haltTimeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (activeRuns > 0) {
          console.warn(
            `[daemon] /halt: ${activeRuns} active run(s) did not settle within ${haltTimeoutMs}ms — they remain active and will still park when they settle`,
          );
        }

        const parkedRuns = await stateMgr.findParkedRuns();
        return {
          halted: true,
          parked: parkedRuns
            .filter((r) => r.parkedBy === 'halt')
            .map((r) => r.issueNumber),
          terminated,
          escalated,
        };
      },
      resume: async () => {
        const sourceReady = await refreshRuntimeSourceForWork('resume');
        if (!sourceReady.ok) return sourceReady;
        paused = false;
        pauseReason = null;
        // A successful resume also clears an active halt interlock so new work
        // does not immediately re-park.
        halting = false;
        // A successful resume clears any watchdog stall — the operator has
        // (re)assessed; the held slot, if any, is the operator's restart concern.
        watchdogStall = null;
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
      // Operator-triggered from-scratch retry of a `stuck` work request
      // (STACK-AC-CONTROL-PLANE; realizes FUNC-AC-PIPELINE "Operator retries a
      // stuck request"). Targets the seed repo (`config.repo`) — the route
      // carries only an issue number. The admission rule + strand-safe reset
      // live in the unit-tested `retryStuckIssue`; here we just resolve the live
      // octokit and wire the in-memory/run-state hooks. `clearInMemoryRunState`
      // drops the activeIssues claim entry; `deleteRunState` removes the parked/
      // partial run file so detection starts a NEW run (never a resume). We do
      // NOT call `releaseClaim` (it strips GitHub tier labels) — the GitHub
      // label choreography is owned by `retryStuckIssue`.
      retry: async (issueNumber) => {
        const seedRepo = config.repo;
        if (!seedRepo) {
          return {
            status: 501,
            body: { error: 'retry unavailable: no repository configured' },
          };
        }
        const retryOctokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
        return retryStuckIssue(
          {
            octokit: retryOctokit,
            owner: seedRepo.owner,
            repo: seedRepo.name,
            clearBackoff: (n) => {
              stuckBackoff.delete(issueKey(seedRepo.owner, seedRepo.name, n));
            },
            clearInMemoryRunState: (n) => {
              activeIssues.delete(n);
            },
            deleteRunState: (n) => stateMgr.deleteRunState(n),
            // STRICT reader: the lenient findParkedRuns() swallows scan/read
            // failures into [] (state.ts), which would make the decision-park
            // admission check pass on an UNREADABLE run store and re-admit a
            // decision-owned issue. findParkedRunsStrict() PROPAGATES the error
            // so retryStuckIssue's fail-closed 503 actually fires in production.
            findParkedRuns: async () =>
              (await stateMgr.findParkedRunsStrict()).map((run) => ({
                issueNumber: run.issueNumber,
                pausedAtPhase: run.pausedAtPhase,
              })),
            log: (message) => console.log(message),
          },
          issueNumber,
        );
      },
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
      // Operator-launched interactive PO session (STACK-AC-PRODUCT-OWNER-INTERACTIVE).
      // The spec's intended entrypoint is a `start_po_session` MCP tool on the
      // coordination terminal server, but that server is not yet wired into the
      // daemon, so the live control-plane HTTP server is the reachable surface
      // today. A single session at a time: refuse (409) if one is already active.
      // The shared PO snapshot is memoized so activeProposals + backlog are read
      // from one consistent assembly rather than two GitHub round-trips.
      startInteractivePoSession: async () => {
        // Synchronous in-process guard FIRST — set before any await so two
        // concurrent requests cannot both pass the fs check below before either
        // writes its (post-assembly) session marker.
        if (interactiveSessionLaunching) {
          return {
            status: 409,
            body: { error: 'an interactive PO session is already active' },
          };
        }
        interactiveSessionLaunching = true;
        try {
          // Cross-process / post-restart guard: an active marker from a prior
          // process. The in-process flag above covers same-process concurrency.
          if (await hasActiveInteractiveSession(poInteractiveSessionsDir)) {
            return {
              status: 409,
              body: { error: 'an interactive PO session is already active' },
            };
          }
          let snapshotPromise:
            | ReturnType<typeof buildProductOwnerSignalSnapshot>
            | undefined;
          const getSnapshot = () => {
            snapshotPromise ??= buildProductOwnerSignalSnapshot(
              {
                repoRoot,
                stateDir,
                loadProposals: loadPOProposals,
                loadIdeas: loadPOIdeas,
                github: poSnapshotGithub,
              },
              poSnapshotConfig,
            );
            return snapshotPromise;
          };
          const result = await startInteractivePOSession({
            stateStore: poStateStore,
            sessionsDir: poInteractiveSessionsDir,
            promptsDir: promptsDirPath,
            runtime,
            loadActiveProposals: async () =>
              (await getSnapshot()).activeProposals,
            loadBacklogSummary: async () => (await getSnapshot()).backlog,
          });
          if (!result.ok) {
            return { status: 500, body: { error: result.error.message } };
          }
          return {
            status: 200,
            body: {
              sessionId: result.value.id,
              endReason: result.value.endReason,
              needsDiscussionResolved: result.value.needsDiscussionResolved,
              summary: result.value.summary,
            },
          };
        } finally {
          interactiveSessionLaunching = false;
        }
      },
      // READ API (slice 7a). `.ledger()` throws when the index is disabled/broken;
      // it is called lazily inside the closure so the route's try/catch maps it to
      // a clean 503. (The operator ANSWER flow is a follow-up that reuses the
      // decision-escalation resume path, not a direct ledger write here.)
      // Inject operator-learning's read-side actuator so the inbox order reflects
      // the Operator's LEARNED attention on top of the explainable base priority
      // (FUNC-AC-OPERATOR-LEARNING rung 1). Membership-preserving + fail-safe: the
      // handler falls back to the base order on any ranker error/invalid output.
      listPendingDecisions: (query) =>
        listPendingDecisions(
          decisionManager.ledger().reader,
          query,
          (items) => operatorLearning.rankInboxItems(items),
        ),
      getDecisionDetail: (id) =>
        getDecisionDetail(decisionManager.ledger().reader, id),
      // REVEAL (5b). Decrypts a protected ref that belongs to the decision.
      // decisionManager.ledger() is called lazily inside the closure so a
      // disabled/broken index maps to 503 rather than crashing the server.
      revealProtected: (id, body, actor) =>
        revealProtected(
          (decisionId, ref, revealActor) =>
            decisionManager.ledger().revealProtected(decisionId, ref, revealActor),
          id,
          body,
          actor,
        ),
      // ANSWER (7c). Option A: the operator answer POSTS a DecisionResponse comment
      // that the existing `resumeParkedRuns` loop recognizes on its next tick — NOT
      // a direct `ledger.answer()` (which would record an answer the resume loop
      // never sees and strand the run). The read model is resolved lazily inside the
      // handler (`.ledger()` throws → mapped to 503). The publisher resolves the gate
      // issue from the decision's `source_url` and posts via the run's octokit.
      answerDecision: (id, body) =>
        answerDecision(
          {
            // LAZY read model: resolve `.ledger()` INSIDE the handler's protected
            // path (it throws when the index is disabled/broken). Resolving it
            // eagerly here would throw synchronously while building deps — before
            // answerDecision's try/catch — and escape the route's promise .catch.
            readModel: {
              listRanked: (args) => decisionManager.ledger().reader.listRanked(args),
              detail: (decisionId) => decisionManager.ledger().reader.detail(decisionId),
            },
            publisher: {
              async publish({ decisionId, chosenOption }) {
                const reader = decisionManager.ledger().reader;
                const detail = await reader.detail(decisionId);
                if (detail === undefined) {
                  throw new Error(`answerDecision: unknown decision ${decisionId}`);
                }
                // Post to the decision's OWN repo (from source_url), resolving that
                // repo's token via the repo manager — NOT the seed config.repo, or a
                // multi-repo answer lands on the wrong issue and the run strands.
                const coords = repoCoordsFromSourceUrl(detail.source_url);
                if (coords === null) {
                  throw new Error(
                    `answerDecision: could not resolve repo/issue from ${detail.source_url}`,
                  );
                }
                const { owner, repo, issueNumber } = coords;
                const repoId = repoManager?.getRepoId(owner, repo) ?? '';
                const answerToken =
                  repoManager !== null && repoId !== ''
                    ? await repoManager.resolveTokenForRepo(repoId)
                    : process.env.GITHUB_TOKEN;
                const answerOctokit = new Octokit({ auth: answerToken });
                await postDecisionResponse({
                  decisionId,
                  chosenOption,
                  // a deterministic, operator-surface idempotency suffix; the resume
                  // matcher anchors on `write_response\b`, so any suffix is recognized.
                  idempotencyKey: `op-${decisionId}`,
                  createComment: (args) => answerOctokit.issues.createComment(args),
                  owner,
                  repo,
                  issueNumber,
                });
              },
            },
          },
          id,
          body,
        ),
      // WIDEN (slice 2): explicit Operator grant to widen autonomy for a lane
      // and/or risk class. Persists via the registry's AutonomyStore.
      widenAutonomy: (id, { riskClass, target, lane, operator }) => {
        const authorization = { kind: 'operator-grant', operator } as const;
        return deploymentRegistry.recordWidening(
          id,
          riskClass as RiskClass,
          target as AutonomyLevel,
          authorization,
          Date.now(),
          lane,
        );
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
  // gap #6 — crash-resumption is a ONE-SHOT startup pass (no retry tick). A
  // detect-phase resume blocked by another in-flight same-repo detect must NOT be
  // skip-and-dropped; it is DEFERRED (per-repo FIFO) and launched EXACTLY ONCE when
  // the holder's detect settles (chained off releaseDetectGateOnce).
  const deferredDetectResumes = new Map<string, Array<() => void>>();

  const launchResumeRun = async (
    run: RunState,
    runOwner: string,
    runRepoName: string,
  ): Promise<void> => {
    const detectRepoKey = `${runOwner}/${runRepoName}`;
    const entersAtDetect = run.phase === 'detect';
    // Gate BEFORE committing the resume. If a detect is already in flight for this
    // repo, defer this launch (one-shot pass — never drop it).
    if (entersAtDetect && detectInFlight.has(detectRepoKey)) {
      const queue = deferredDetectResumes.get(detectRepoKey) ?? [];
      queue.push(() => {
        void launchResumeRun(run, runOwner, runRepoName);
      });
      deferredDetectResumes.set(detectRepoKey, queue);
      console.log(
        `[daemon] Deferred crash-resume detect run #${run.issueNumber} — detect already in flight for ${detectRepoKey}`,
      );
      return;
    }
    if (entersAtDetect) detectInFlight.add(detectRepoKey);
    // Per-run idempotent release: frees the repo's detect gate and fires the next
    // FIFO-deferred same-repo resume (if any). Idempotent so the detect-settled
    // EARLY release and the runPipeline `.finally` / setup-throw backstop are safe
    // to call in any order without double-launching or clobbering a later run.
    let gateReleased = false;
    const releaseDetectGateOnce = (): void => {
      if (gateReleased) return;
      gateReleased = true;
      if (!entersAtDetect) return;
      detectInFlight.delete(detectRepoKey);
      const queue = deferredDetectResumes.get(detectRepoKey);
      const next = queue?.shift();
      if (next) next();
    };
    // Only detect entrants thread the EARLY release into createPhaseHandlers.
    const onDetectSettled = entersAtDetect ? releaseDetectGateOnce : undefined;

    run.deploymentId = config.deployment?.id;
    activeIssues.add(run.issueNumber);
    activeRuns++;

    // Look up repoId for DB-mode repo tracking
    const resumeRepoId = repoManager?.getRepoId(runOwner, runRepoName) ?? '';
    if (repoManager && resumeRepoId) {
      repoManager.notifyRunStart(resumeRepoId);
    }

    try {
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
                configReader?.getRepoConfig(runOwner, runRepoName)
                  ?.activePlugins,
                knowledgeStore,
                phaseLabelMirror,
                decisionManager,
                undefined,
                deploymentRegistry,
                sanitizationPipeline,
                // gap #6: EARLY release when the resumed detect settles (omitted for
                // website / post-detect resumes).
                onDetectSettled,
                // P0.5 pause gate at integrate-entry.
                () => paused,
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
        () => halting,
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
          finishActiveRun();
          activeIssues.delete(run.issueNumber);
          if (repoManager && resumeRepoId) {
            repoManager.notifyRunEnd(resumeRepoId);
          }
          // gap #6 run-level backstop (covers a detect that never settles, e.g. a
          // throw inside the FSM). Idempotent with the EARLY release above.
          releaseDetectGateOnce();
        });
    } catch (setupErr) {
      // gap #6 setup-throw backstop: the inline setup above runs BEFORE any
      // runPipeline `.finally` exists, so a throw here must free the gate directly
      // (a plain outer `finally` would release synchronously BEFORE detect runs).
      releaseDetectGateOnce();
      finishActiveRun();
      activeIssues.delete(run.issueNumber);
      if (repoManager !== null && resumeRepoId !== '') {
        repoManager.notifyRunEnd(resumeRepoId);
      }
      console.error(
        `[daemon] Crash-resume setup failed for #${run.issueNumber}:`,
        setupErr,
      );
    }
  };

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
    await launchResumeRun(run, runOwner, runRepoName);
  }

  // 6c. Heartbeat — write a timestamp file for operator monitoring (health.sh compatibility)
  const heartbeatPath = join(
    process.env.HOME ?? '/tmp',
    'logs',
    'claude-daemon.heartbeat',
  );
  const stopHeartbeat = startHeartbeat(heartbeatPath, config.pollIntervalMs);

  // 6c-bis. B5 work-loop watchdog (first-use safety net). DETECTS a stalled work
  // loop (run-stall or tick-stall past idle-timeout) and self-pauses
  // (pauseReason='stuck') + notifies + flips /health to 503. CRITICAL SAFETY: it
  // never decrements activeRuns and never cancels the run — the held slot is
  // recovered by operator restart (see watchdog.ts header). The signal reader is
  // injectable for deterministic tests; production reads the persisted run
  // progress + the repo poller snapshots.
  const readWatchdogSignals =
    opts?.watchdog?.readSignals ??
    (async (): Promise<WatchdogSignals> => ({
      activeRunProgress: await readActiveRunProgress(activeIssues, (issue) =>
        stateMgr.loadRunState(issue),
      ),
      pollerSnapshots: repoManager?.pollerSnapshot() ?? [],
    }));
  const watchdog = createWatchdog({
    now: watchdogNow,
    idleTimeoutMs: watchdogIdleTimeoutMs,
    readSignals: readWatchdogSignals,
    isPaused: () => paused,
    isShuttingDown: () => shuttingDown || draining,
    onStall: (stall) => {
      paused = true;
      pauseReason = 'stuck';
      watchdogStall = stall;
      console.warn(
        `[daemon] Watchdog detected ${stall.kind}: ${stall.detail} — self-pausing ` +
          `(claiming no new work). The held concurrency slot is NOT auto-released; ` +
          `restart the daemon to recover it. /health is now 503.`,
      );
      notifyOperator({
        event: 'watchdog-stall',
        issueNumber: 0,
        phase: stall.kind,
        message: `Daemon watchdog self-paused: ${stall.detail}`,
      });
    },
  });
  const watchdogIntervalMs =
    opts?.watchdog?.intervalMs ?? Math.min(config.pollIntervalMs, 60_000);
  const watchdogHandle = setInterval(() => {
    void watchdog.tick();
  }, watchdogIntervalMs);

  // 6d. resumeParkedRuns — check parked runs for l2-approved/l2-rejected label, re-enter pipeline
  async function resumeParkedRuns(): Promise<void> {
    if (paused || draining || shuttingDown) return;
    const sourceReady = await refreshRuntimeSourceForWork('parked run resume');
    if (!sourceReady.ok) return;
    const parkedRuns = await stateMgr.findParkedRuns();
    // Limit to 1 resume per cycle to avoid thundering-herd
    for (const run of parkedRuns.slice(0, 1)) {
      if (activeIssues.has(run.issueNumber)) continue; // already running

      // HALT arm (precedence over decision-parked branches): a run parked by
      // /halt re-enters at its pausedAtPhase once the daemon is unpaused. Clear
      // BOTH parkedBy and pausedAtPhase before re-entry/persist so a later
      // legitimate decision park is not mistaken for a halt park.
      if (run.parkedBy === 'halt') {
        const runOwner = run.repoOwner ?? config.repo?.owner;
        const runRepoName = run.repoName ?? config.repo?.name;
        if (
          runOwner === undefined ||
          runOwner === '' ||
          runRepoName === undefined ||
          runRepoName === ''
        ) {
          console.warn(
            `[daemon] resumeParkedRuns: skipping halt-parked run #${run.issueNumber} — missing repo info`,
          );
          continue;
        }
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

        run.phase = run.pausedAtPhase ?? run.phase;
        run.pausedAtPhase = undefined;
        run.parkedBy = undefined;
        await stateMgr.saveRunState(run);
        await reenterPipeline(
          run,
          runOwner,
          runRepoName,
          resumeRepoId,
          runOctokit,
          phaseLabelMirror,
        );
        continue;
      }

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
            (await decisionManager.ledger().statusOf(decisionId)) === 'resumed';
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
          // answer() is async (real Postgres writer) — AWAIT it so the row is
          // durably `answered_pending_source_write` before advanceToResumed runs;
          // a fire-and-forget call races the advance, which then no-ops on the
          // not-yet-answered row and strands it. await also routes an async
          // rejection into this fail-closed catch.
          await decisionManager.ledger().answer(decisionId, choice, 'operator');
        } catch (e) {
          console.warn(
            `[daemon] resumeParkedRuns: decision-index answer failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
      }

      // Behavioral learning: record the operator's l2-gate decision (fire-and-forget).
      operatorLearning.observeDecisionAnswer({
        decisionClass: 'l2_gate',
        context: `${runOwner}/${runRepoName}`,
        sourceDecisionId: decisionId,
        chosenOption: choice,
      }).catch((e) =>
        console.warn(
          `[daemon] resumeParkedRuns: operator-learning observation failed for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );

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
          (await decisionManager.ledger().statusOf(decisionId)) === 'resumed';
      } catch (e) {
        // Governed-only marking: a statusOf failure here means the approval
        // surface is unreachable at runtime for this configured deployment. Mark
        // the index runtime-degraded (observable at /health) — fail-closed flow is
        // unchanged (stay parked).
        markRuntimeDegradedIfGoverned(
          decisionManager,
          config.deployment?.id,
          e instanceof Error ? e.message : String(e),
        );
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
        // AWAIT the async answer() (real Postgres writer) so the row is durably
        // recorded before advanceToResumed; a fire-and-forget call races the
        // advance and strands the run at answered_pending_source_write. await also
        // routes an async rejection into this fail-closed catch.
        await decisionManager
          .ledger()
          .answer(decisionId, answer.rawChosenOption, 'operator');
      } catch (e) {
        // Governed-only marking: an answer() failure is a runtime decision-index
        // fault for this configured deployment. Mark runtime-degraded; stay parked.
        markRuntimeDegradedIfGoverned(
          decisionManager,
          config.deployment?.id,
          e instanceof Error ? e.message : String(e),
        );
        console.warn(
          `[daemon] resumeParkedRuns: decision-index answer failed for #${run.issueNumber} (failing closed, staying parked): ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }

      // Behavioral learning: record the operator's integrate decision (fire-and-forget).
      operatorLearning
        .observeDecisionAnswer({
          decisionClass: 'merge_decision',
          context: `${runOwner}/${runRepoName}`,
          sourceDecisionId: decisionId,
          chosenOption: answer.choice,
        })
        .catch((e) =>
          console.warn(
            `[daemon] resumeParkedRuns: operator-learning observation failed for #${run.issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );

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
        // A successful advanceToResumed is a successful GOVERNED merge-decision op:
        // the approval surface is reachable + writable again, so clear any
        // runtime-degraded marker a prior approval-path failure set.
        clearRuntimeDegradedIfGoverned(decisionManager, config.deployment?.id);
      } catch (e) {
        markRuntimeDegradedIfGoverned(
          decisionManager,
          config.deployment?.id,
          e instanceof Error ? e.message : String(e),
        );
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
                sanitizationPipeline,
                // gap #6: EARLY release when the resumed detect settles (omitted for
                // website / post-detect resumes).
                undefined,
                // P0.5 pause gate at integrate-entry.
                () => paused,
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
        () => halting,
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
          finishActiveRun();
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
    knowledgeMaintenance.stop();
    stopReviewScheduler();
    stopPOAgent?.();
    stopTechLeadScheduler?.();
    clearInterval(watchdogHandle);
    repoManager?.stop();
    // If no active runs, shut down immediately
    if (activeRuns === 0) {
      console.log('[daemon] No active runs — shutting down immediately');
      await shutdown();
    }
    // Otherwise, finishActiveRun() calls shutdown() when activeRuns hits 0 (it
    // runs AFTER the run-promise's activeRuns decrement, so the final run reliably
    // completes the drain — see finishActiveRun).
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');
    if (knowledgeSyncPoller) clearInterval(knowledgeSyncPoller);
    knowledgeMaintenance.stop();
    stopHeartbeat();
    clearInterval(watchdogHandle);
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
    // Signal the crash handler (and any other awaiter) that graceful shutdown
    // has ACTUALLY completed. Idempotent — Promise resolution only counts once.
    resolveShutdownComplete();
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

  // T2.7 (first-use safety net): top-level crash handlers, installed INSIDE
  // startDaemon (after config load) so the alert channel + the private drain are
  // in scope — main.ts has neither. An uncaughtException / unhandledRejection
  // notifies the Operator (non-silent even with no channel, via notifyOperator)
  // and exits gracefully instead of going dark or hard-exiting. NOTE the plist
  // crash-loop caveat (KeepAlive=true + ThrottleInterval=30) in docs/running.md.
  //
  // `shutdown` triggers the drain AND returns `shutdownComplete`, which resolves
  // ONLY after the real graceful shutdown() finishes (active runs drained + the
  // server/DB closed). enterDrainMode() alone returns immediately while runs are
  // active, so awaiting IT would exit instantly — instead we await actual
  // completion: a clean active run drains then exits, while a WEDGED run leaves
  // shutdownComplete pending so the crash handler's bounded force-exit timer (5s)
  // performs the exit. exit-once is guaranteed inside createCrashHandlers.
  const crashHandlers = createCrashHandlers({
    notifyOperator,
    shutdown: () => {
      void enterDrainMode();
      return shutdownComplete;
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
  process.on('uncaughtException', crashHandlers.onUncaughtException);
  process.on('unhandledRejection', crashHandlers.onUnhandledRejection);

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
      const degradedMessage = `Daemon startup-degraded: Data Service unreachable after ${consecutive} background attempts (${code ?? 'no-code'}: ${message})`;
      if (opts.webhooks.length === 0) {
        // B1: never let the escalation disappear into the void when no channel
        // is configured.
        console.warn(`[daemon] ALERT NOT DELIVERED (no alert channel configured): startup-degraded — ${degradedMessage}`);
      } else {
        void notify(opts.webhooks, {
          event: 'startup-degraded',
          issueNumber: 0,
          phase: 'startup',
          message: degradedMessage,
        });
      }
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

export async function preClassifyReadyWork(
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
      if (!item || item.classified !== true || item.complexity === undefined) return request;
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
  protectedStore?: ProtectedStore,
  // gap #6: per-run idempotent detect-gate release. Threaded into createPhaseHandlers
  // as onDetectSettled (non-website branch only) for EARLY release when detect
  // settles. The caller ALSO attaches it to this promise's `.finally` as a
  // setup-throw backstop (a throw in the pre-detect setup below rejects the
  // returned promise, so the caller's `.finally` still frees the gate).
  onDetectSettled?: () => void,
  // P0.5 halt interlock: read the daemon-scoped halting flag inside runPipeline.
  isHalting?: () => boolean,
  // P0.5 pause gate: read the daemon-scoped paused flag inside createPhaseHandlers
  // so integrate-entry parks instead of merging while paused.
  isPaused?: () => boolean,
): Promise<string> {
  const today = new Date().toISOString().split('T')[0];
  if (today !== dailyRunState.resetDate) {
    dailyRunState.count = 0;
    dailyRunState.resetDate = today!;
  }
  dailyRunState.count++;
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
  const perRunSanitizationPipeline = buildSanitizationPipelineForDeployment(
    registry,
    config.deployment?.id,
    { protectedStore },
  );
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
            perRunSanitizationPipeline,
            // gap #6: EARLY detect-gate release. Website branch omits it (starts at
            // 'init', never gated).
            onDetectSettled,
            // P0.5 pause gate at integrate-entry.
            isPaused,
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
    isHalting,
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
