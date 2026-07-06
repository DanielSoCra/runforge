// packages/daemon/src/control-plane/first-use-safety-net.test.ts
// PR2 (first-use safety net) daemon-level WIRING tests. The pure logic lives in
// (and is exhaustively tested by) watchdog.test.ts / health.test.ts /
// crash-handlers.test.ts / config.test.ts; this file drives startDaemon through
// the same mock harness as first-use-boot-guard.test.ts to assert the wiring:
//   - pauseReason stamped per set-paused site + surfaced on getStatus (T2.1)
//   - B2 governed-without-channel → boots + warns + alertChannelDegraded flag (T2.3)
//   - B5 watchdog → self-pause(stuck) + notify + 503 + activeRuns UNCHANGED (T2.5)
//   - B4 /health wiring: manual=200-degraded, safety/watchdog=503 (T2.6)
//   - T2.7 crash handlers installed inside startDaemon
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok } from '../lib/result.js';
import type { Config } from '../config.js';
import type { WorkRequest } from '../types.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';

const makeWorkRequest = (overrides?: Partial<WorkRequest>): WorkRequest => ({
  issueNumber: 1,
  title: 'Test issue',
  body: 'Fix the thing',
  labels: ['ready'],
  specRefs: [],
  ...overrides,
});

const {
  mockStateMgr,
  mockCostTracker,
  mockRemoteControl,
  mockDetector,
  mockServer,
  mockServerStart,
  mockDegradedStart,
  mockDegradedClose,
  mockRunPipeline,
  mockNotify,
  mockRunWriter,
  mockConfigReader,
  mockRepoSource,
  mockRunHistory,
  mockDbSqlEnd,
  mockLoadConfig,
  mockSelectVariant,
  phaseHandlerCalls,
  mockCreateReviewScheduler,
  mockCreatePOAgent,
  mockCreateTechLeadScheduler,
  mockCreateCoordinator,
  mockOctokit,
  mockValidatePromptContracts,
  mockClassifyBatch,
  mockBuildRuntimeSourcePolicy,
  mockValidateRuntimeSource,
  mockGetStartPhase,
  mockEnsureWorkspaceRepo,
  mockStartHeartbeat,
  mockOperatorLearningInit,
  mockHasActiveInteractiveSession,
  mockStartInteractivePOSession,
  mockCloseOrphanedSessions,
} = vi.hoisted(() => ({
  mockStateMgr: {
    initialize: vi.fn().mockResolvedValue(undefined),
    saveRunState: vi.fn().mockResolvedValue(undefined),
    loadRunState: vi.fn().mockResolvedValue({ ok: false, error: new Error('none') }),
    findIncompleteRuns: vi.fn().mockResolvedValue([]),
    findParkedRuns: vi.fn().mockResolvedValue([]),
  },
  mockCostTracker: {
    getDailyCost: vi.fn().mockReturnValue(0),
    maybeResetDaily: vi.fn(),
  },
  mockRemoteControl: {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn(),
    getState: vi.fn().mockReturnValue({}),
  },
  mockDetector: {
    detectReadyWork: vi.fn(),
    detectBugFixWork: vi.fn(),
    detectFeaturePipelineWork: vi.fn(),
    claimWork: vi.fn(),
    claimBugFixWork: vi.fn(),
    claimFeaturePipelineWork: vi.fn(),
    markStuck: vi.fn(),
  },
  mockServer: {
    close: vi.fn((cb?: () => void) => {
      cb?.();
    }),
  },
  mockServerStart: vi.fn(),
  mockDegradedStart: vi.fn(),
  mockDegradedClose: vi.fn(),
  mockRunPipeline: vi.fn(),
  mockNotify: vi.fn(),
  mockRunWriter: {
    insertRun: vi.fn(),
    upsertRun: vi.fn(),
    writeCostEvent: vi.fn(),
  },
  mockConfigReader: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getGlobalConfig: vi.fn().mockReturnValue(null),
    getRepoConfig: vi.fn().mockReturnValue(null),
    tryFetch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isStartupDegraded: vi.fn().mockReturnValue(false),
    getLastConfigError: vi.fn().mockReturnValue(null),
  },
  mockRepoSource: {
    listEnabledRepos: vi.fn(),
    upsertRepo: vi.fn(),
    resolveConnectionToken: vi.fn().mockResolvedValue(undefined),
  },
  mockRunHistory: {
    countStuckRunsForIssue: vi.fn().mockResolvedValue(0),
    markInProgressRunsStuck: vi.fn().mockResolvedValue(0),
  },
  mockDbSqlEnd: vi.fn().mockResolvedValue(undefined),
  mockLoadConfig: vi.fn(),
  mockSelectVariant: vi.fn(),
  phaseHandlerCalls: [] as unknown[][],
  mockCreateReviewScheduler: vi
    .fn()
    .mockReturnValue({ start: () => () => {}, getStatus: () => ({}) }),
  mockCreatePOAgent: vi.fn(),
  mockCreateTechLeadScheduler: vi.fn(),
  mockCreateCoordinator: vi.fn(),
  mockOctokit: {
    issues: {
      get: vi.fn().mockResolvedValue({ data: { labels: [], state: 'open' } }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      createLabel: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  mockValidatePromptContracts: vi.fn(),
  mockClassifyBatch: vi.fn(),
  mockBuildRuntimeSourcePolicy: vi.fn(),
  mockValidateRuntimeSource: vi.fn(),
  mockGetStartPhase: vi.fn(),
  mockEnsureWorkspaceRepo: vi.fn().mockResolvedValue(process.cwd()),
  mockStartHeartbeat: vi.fn().mockReturnValue(vi.fn()),
  mockOperatorLearningInit: vi.fn().mockResolvedValue(undefined),
  mockHasActiveInteractiveSession: vi.fn().mockResolvedValue(false),
  mockStartInteractivePOSession: vi.fn(),
  mockCloseOrphanedSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('./state.js', () => ({
  StateManager: class {
    initialize = mockStateMgr.initialize;
    saveRunState = mockStateMgr.saveRunState;
    loadRunState = mockStateMgr.loadRunState;
    findIncompleteRuns = mockStateMgr.findIncompleteRuns;
    findParkedRuns = mockStateMgr.findParkedRuns;
  },
}));

vi.mock('../session-runtime/cost.js', () => ({
  CostTracker: class {
    getDailyCost = mockCostTracker.getDailyCost;
    maybeResetDaily = mockCostTracker.maybeResetDaily;
  },
}));

vi.mock('../session-runtime/runtime.js', () => ({
  SessionRuntime: class {
    spawnSession = vi.fn();
    getProviderRegistry = () => ({
      markSmokeProof: vi.fn(),
      markSmokeFailed: vi.fn(),
    });
  },
  preloadPromptCache: async () => 0,
}));

vi.mock('../session-runtime/managed-processes.js', () => ({
  killAllManagedProcessGroups: vi.fn(() => 0),
  managedProcessCount: vi.fn(() => 0),
  registerManagedProcess: vi.fn(),
  unregisterManagedProcess: vi.fn(),
  killProcessGroup: vi.fn(),
}));

vi.mock('../knowledge/gotcha-store.js', () => ({ GotchaStore: class {} }));
vi.mock('../knowledge/knowledge-store.js', () => ({ KnowledgeStore: class {} }));
vi.mock('../knowledge/policy-registry.js', () => ({ DEFAULT_POLICIES: {} }));
vi.mock('../knowledge/prompt-contracts.js', () => ({
  validatePromptContracts: mockValidatePromptContracts,
}));
vi.mock('../knowledge/maintenance.js', () => ({
  startKnowledgeMaintenance: () => ({
    stop: vi.fn(),
    triggerNow: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../operator-learning/index.js', () => ({
  OperatorLearningService: class {
    init = mockOperatorLearningInit;
  },
}));
vi.mock('../implementation/coordinator.js', () => ({
  ImplementationCoordinator: class {},
}));
vi.mock('./remote-control.js', () => ({
  RemoteControlManager: class {
    start = mockRemoteControl.start;
    stop = mockRemoteControl.stop;
    restart = mockRemoteControl.restart;
    getState = mockRemoteControl.getState;
  },
}));
vi.mock('./work-detection.js', () => ({
  createWorkDetector: () => mockDetector,
}));
vi.mock('./batch-classifier.js', () => ({
  classifyBatch: (...args: unknown[]) => mockClassifyBatch(...args),
}));
vi.mock('./server.js', () => ({
  createControlServer: vi.fn((_port: number, _handlers: unknown) => ({
    server: mockServer,
    start: mockServerStart,
  })),
}));
vi.mock('./degraded-server.js', () => ({
  createDegradedServer: vi.fn(
    (_port: number, _host: string, _getState: unknown) => ({
      start: mockDegradedStart,
      handle: { close: mockDegradedClose },
    }),
  ),
}));
vi.mock('./phases.js', () => ({
  createPhaseHandlers: (...args: unknown[]) => {
    phaseHandlerCalls.push(args);
    return {};
  },
}));
vi.mock('./phases-website.js', () => ({
  createWebsitePhaseHandlers: () => ({}),
}));
vi.mock('./agency-config.js', () => ({
  readAgencyConfig: () => Promise.resolve({}),
}));
vi.mock('./pipeline.js', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args),
}));
vi.mock('./fsm.js', () => ({
  getPipeline: () => ({}),
  getStartPhase: (...args: unknown[]) => mockGetStartPhase(...args),
}));
vi.mock('./variants.js', () => ({
  selectVariant: (...args: unknown[]) => mockSelectVariant(...args),
}));
vi.mock('./notify.js', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));
vi.mock('./runtime-source.js', () => ({
  buildRuntimeSourcePolicy: (...args: unknown[]) =>
    mockBuildRuntimeSourcePolicy(...args),
  validateRuntimeSource: (...args: unknown[]) =>
    mockValidateRuntimeSource(...args),
}));
vi.mock('./workspace-bootstrap.js', () => ({
  ensureWorkspaceRepo: (...args: unknown[]) => mockEnsureWorkspaceRepo(...args),
}));
vi.mock('./heartbeat.js', () => ({
  startHeartbeat: (...args: unknown[]) => mockStartHeartbeat(...args),
}));
vi.mock('@runforge/db', () => ({
  createDbClient: () => ({ db: {}, sql: { end: mockDbSqlEnd } }),
  createPostgresStores: () => ({
    settings: {},
    repos: {},
    plugins: {},
    runs: {},
    costs: {},
    credentials: {},
  }),
  readCredentialKey: () => Buffer.alloc(32, 1),
}));
vi.mock('../data/config-reader.js', () => ({
  PostgresConfigReader: class {
    start = mockConfigReader.start;
    stop = mockConfigReader.stop;
    getGlobalConfig = mockConfigReader.getGlobalConfig;
    getRepoConfig = mockConfigReader.getRepoConfig;
    tryFetch = mockConfigReader.tryFetch;
    isStartupDegraded = mockConfigReader.isStartupDegraded;
    getLastConfigError = mockConfigReader.getLastConfigError;
  },
}));
vi.mock('../data/run-writer.js', () => ({
  PostgresRunWriter: class {
    insertRun = mockRunWriter.insertRun;
    upsertRun = mockRunWriter.upsertRun;
    writeCostEvent = mockRunWriter.writeCostEvent;
  },
  toDbOutcome: (outcome: string) => outcome,
}));
vi.mock('../data/repo-source.js', () => ({
  PostgresRepoDataSource: class {
    listEnabledRepos = mockRepoSource.listEnabledRepos;
    upsertRepo = mockRepoSource.upsertRepo;
    resolveConnectionToken = mockRepoSource.resolveConnectionToken;
  },
}));
vi.mock('../data/run-history.js', () => ({
  PostgresRunHistory: class {
    countStuckRunsForIssue = mockRunHistory.countStuckRunsForIssue;
    markInProgressRunsStuck = mockRunHistory.markInProgressRunsStuck;
  },
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    issues = mockOctokit.issues;
  },
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));
vi.mock('../coordination/review-scheduler.js', () => ({
  createReviewScheduler: (...args: unknown[]) =>
    mockCreateReviewScheduler(...args),
}));
vi.mock('../coordination/po-agent.js', () => ({
  createPOAgent: (...args: unknown[]) => mockCreatePOAgent(...args),
}));
vi.mock('../coordination/product-owner/interactive-session-context.js', () => ({
  hasActiveInteractiveSession: (...args: unknown[]) =>
    mockHasActiveInteractiveSession(...args),
  startInteractivePOSession: (...args: unknown[]) =>
    mockStartInteractivePOSession(...args),
  closeOrphanedSessions: (...args: unknown[]) =>
    mockCloseOrphanedSessions(...args),
}));
vi.mock('../coordination/tech-lead-scheduler.js', () => ({
  createTechLeadScheduler: (...args: unknown[]) =>
    mockCreateTechLeadScheduler(...args),
}));
vi.mock('../coordination/coordinator.js', () => ({
  createCoordinator: (...args: unknown[]) => mockCreateCoordinator(...args),
}));
vi.mock('../coordination/work-claimer.js', () => ({
  createWorkClaimer: vi.fn().mockReturnValue({}),
}));
vi.mock('../coordination/batch-manager.js', () => ({
  createBatchManager: vi.fn().mockReturnValue({}),
}));
vi.mock('../coordination/merge-agent.js', () => ({
  createMergeAgent: vi.fn().mockReturnValue({}),
}));
vi.mock('../coordination/merge-queue.js', () => ({
  createMergeQueue: vi.fn().mockReturnValue({}),
}));
vi.mock('../coordination/tech-lead/proposal-store.js', () => ({
  TechProposalStore: class {
    init = vi.fn().mockResolvedValue(undefined);
    loadActiveProposals = vi.fn().mockResolvedValue([]);
    loadRejectedProposals = vi.fn().mockResolvedValue([]);
    loadAllProposals = vi.fn().mockResolvedValue([]);
    findDuplicate = vi.fn().mockResolvedValue(undefined);
    saveProposal = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('../coordination/tech-lead/signal-digest.js', () => ({
  assembleSignalDigest: vi.fn().mockResolvedValue({
    id: 'digest-1',
    trigger: 'scheduled',
    reviewFindings: [],
    runOutcomes: [],
    driftIndicators: [],
    deferredWork: [],
    testHealth: [],
    dependencyRisks: [],
    activeProposals: [],
    priorRejections: [],
    missingSources: [],
    assembledAt: '2026-03-23T00:00:00Z',
  }),
}));
vi.mock('../coordination/tech-lead/proposal-lifecycle.js', () => ({
  isTerminalStatus: vi.fn().mockReturnValue(false),
}));

const HEALTHY_SOURCE = {
  enabled: true,
  healthy: true,
  sourceRoot: '/repo',
  currentRef: 'staging',
  head: 'abc123',
  expectedRef: 'origin/staging',
  clean: true,
  dirtyPaths: [],
  synchronized: true,
  checkedAt: '2026-06-26T00:00:00.000Z',
  action: 'pause',
} as const;

const makeConfig = (overrides?: Partial<Config>): Config => ({
  controlPort: 3847,
  controlHost: '127.0.0.1',
  pollIntervalMs: 30000,
  maxConcurrentRuns: 1,
  operatorReviewCategories: [],
  classifierBatchSize: 10,
  dailyBudget: 50,
  perRunBudget: 10,
  adapter: 'cli' as const,
  autonomous: false,
  remoteControl: { enabled: false },
  runtimeSource: {
    enabled: true,
    requireClean: true,
    requireExpectedRef: true,
    onUnhealthy: 'pause',
    ignoredDirtyPaths: ['state/', 'workspaces/'],
  },
  branches: { staging: 'staging', production: 'main' },
  webhooks: [],
  validation: {
    gate1Commands: [],
    maxFixCycles: 3,
    baselinePreexistingFailures: false,
    staticAnalysis: { maxComplexity: 15, maxFunctionLength: 50, maxFileSize: 500 },
    diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
    healthCheckIntervalMs: 5000,
    deployTimeoutMs: 120000,
    maxDeployAttempts: 2,
    testCommands: [],
    maxTestFixAttempts: 3,
    failureExcerptLines: 50,
    proactiveIntervalMs: 1200000,
    proactiveMaxConcurrent: 1,
    proactiveThrottleThreshold: 0.8,
    proactiveRecentCommits: 20,
  },
  coordination: {
    useCoordinator: false,
    tickInterval: 5000,
    maxAgents: 10,
    reviewerInterval: 3600000,
    poInterval: 3600000,
    poIdeaDebounce: 300000,
    poFindingDailyCap: 5,
    poInteractiveTimeout: 1800,
    poSharedStateRetentionDays: 7,
    poMaxWriteRetries: 3,
    plannerTimeout: 60000,
    maxAttemptsPerIssue: 3,
    diskSpaceThreshold: 2_000_000_000,
    gcInterval: 600000,
    conflictFileThreshold: 3,
    conflictLineThreshold: 100,
    mergeDependencyTimeout: 1800000,
    mergeValidationTimeout: 600000,
    mergePollInterval: 5000,
    mergePollMaxInterval: 60000,
    techLeadInterval: 7200000,
    techLeadEventDebounce: 300000,
    techLeadProposalExpiryMs: 604800000,
    techLeadLookbackWindowMs: 172800000,
    techLeadMaxEntriesPerSection: 50,
    triageDailyCap: 5,
    maxConsecutiveTickErrors: 5,
  },
  diagnosis: { confidenceThreshold: 0.7 },
  warmup: { threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 },
  knowledge: {
    systemicProposalThreshold: 3,
    systemicProposalCooldownDays: 30,
    candidateTimeoutDays: 14,
    prospectiveSeverityThreshold: 5,
  },
  maxConsecutiveStuck: 3,
  gracePeriodMs: 100,
  maxRunsPerIssue: 3,
  retryBackoffBaseMs: 60_000,
  retryBackoffMaxMs: 1_800_000,
  governance: { documentPath: 'FACTORY_RULES.md', maxPrLinesChanged: 2000 },
  agentScopes: {},
  roleModels: {},
  activePlugins: [],
  repo: { owner: 'test-owner', name: 'test-repo' },
  ...overrides,
});

function makeDeploymentProfile(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    repositories: [{ owner: 'test-owner', name: 'test-repo' }],
    riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity', 'clinical'],
      mostCautiousLane: 'standard',
      lanes: [
        {
          name: 'trivial',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: 'gate1',
          mergePolicy: 'auto',
        },
        {
          name: 'standard',
          qualify: { complexity: ['standard', 'complex'] },
          allowedPaths: ['**'],
          roleRouting: { implement: 'cheap-implementer' },
          gateSet: { velocity: 'gate1-plus', clinical: 'full' },
          mergePolicy: { velocity: 'review-then-auto', clinical: 'hold' },
        },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: {
      automatable: ['docs'],
      strained: [],
      irreduciblyHuman: ['triage'],
    },
    budget: 5000,
    landing: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' } },
    capabilityBindings: [],
    ...overrides,
  };
}

function makeDecisionManager(
  state: 'disabled' | 'unavailable' | 'available',
): DecisionIndexManager {
  const ledger = {
    reconcile: vi.fn().mockResolvedValue(undefined),
    expireOverdue: vi.fn().mockResolvedValue(undefined),
    reader: { listRanked: vi.fn(), detail: vi.fn() },
    protectedStore: () => ({
      put: vi.fn(),
      findRefForField: vi.fn(),
      get: vi.fn(),
      responseHmac: vi.fn(),
      verifyIntegrity: vi.fn(),
    }),
    revealProtected: vi.fn(),
  };
  return {
    init: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn(() => state !== 'disabled'),
    isAvailable: vi.fn(() => state === 'available'),
    isRuntimeDegraded: vi.fn(() => false),
    markRuntimeDegraded: vi.fn(),
    clearRuntimeDegraded: vi.fn(),
    ledger: vi.fn(() => {
      if (state === 'disabled') throw new Error('decision index disabled');
      if (state === 'unavailable') throw new Error('decision index unavailable');
      return ledger;
    }),
    protectedStore: vi.fn(() => {
      if (state !== 'available') throw new Error('unavailable');
      return ledger.protectedStore();
    }),
    revealProtected: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DecisionIndexManager;
}

const loadDaemon = async () => {
  const mod = await import('./daemon.js');
  mod.__resetDailyRunStateForTests();
  return mod;
};

type Handlers = {
  getStatus: () => Record<string, unknown>;
  getHealth: () => { ok: boolean; degraded: boolean; reason: string | null };
  pause: () => void;
  resume: () => Promise<unknown>;
};

async function handlersFromLastBoot(): Promise<Handlers> {
  const { createControlServer } = await import('./server.js');
  return vi.mocked(createControlServer).mock.lastCall![1] as unknown as Handlers;
}

describe('first-use safety net (PR2 wiring)', () => {
  const originalEnv = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    RUNFORGE_DATABASE_URL: process.env.RUNFORGE_DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    DAEMON_DATA_BACKEND: process.env.DAEMON_DATA_BACKEND,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.RUNFORGE_DATABASE_URL = 'postgres://test';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64url');
    process.env.DAEMON_DATA_BACKEND = 'postgres';

    vi.spyOn(process, 'on').mockImplementation(((
      _event: string,
      _handler: () => Promise<void>,
    ) => process) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockLoadConfig.mockResolvedValue(ok(makeConfig()));
    mockDetector.detectReadyWork.mockResolvedValue(ok([]));
    mockDetector.detectBugFixWork.mockResolvedValue(ok(null));
    mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(null));
    mockDetector.claimWork.mockResolvedValue(ok(undefined));
    mockDetector.claimBugFixWork.mockResolvedValue(ok(undefined));
    mockDetector.claimFeaturePipelineWork.mockResolvedValue(ok(undefined));
    mockDetector.markStuck.mockResolvedValue(ok(undefined));
    mockSelectVariant.mockReturnValue('feature');
    mockGetStartPhase.mockReturnValue('detect');
    mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
    mockServerStart.mockResolvedValue(ok(undefined));
    mockDegradedStart.mockResolvedValue(ok(undefined));
    mockDegradedClose.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue({ failedUrls: [] });
    mockStateMgr.initialize.mockResolvedValue(undefined);
    mockStateMgr.saveRunState.mockResolvedValue(undefined);
    mockStateMgr.loadRunState.mockResolvedValue({
      ok: false,
      error: new Error('none'),
    });
    mockStateMgr.findIncompleteRuns.mockResolvedValue([]);
    mockStateMgr.findParkedRuns.mockResolvedValue([]);
    mockConfigReader.start.mockResolvedValue(undefined);
    mockConfigReader.stop.mockReturnValue(undefined);
    mockConfigReader.getGlobalConfig.mockReturnValue(null);
    mockConfigReader.getRepoConfig.mockReturnValue(null);
    mockConfigReader.tryFetch.mockResolvedValue({ ok: true, value: undefined });
    mockConfigReader.isStartupDegraded.mockReturnValue(false);
    mockConfigReader.getLastConfigError.mockReturnValue(null);
    mockRepoSource.listEnabledRepos.mockResolvedValue(
      ok([
        {
          id: 'repo-id',
          owner: 'test-owner',
          name: 'test-repo',
          poll_interval_ms: null,
          connection_id: null,
        },
      ]),
    );
    mockRepoSource.upsertRepo.mockResolvedValue(ok('repo-id'));
    mockRepoSource.resolveConnectionToken.mockResolvedValue(undefined);
    mockRunHistory.countStuckRunsForIssue.mockResolvedValue(0);
    mockRunHistory.markInProgressRunsStuck.mockResolvedValue(0);
    mockDbSqlEnd.mockResolvedValue(undefined);
    mockValidatePromptContracts.mockResolvedValue(ok({ checked: 3 }));
    mockBuildRuntimeSourcePolicy.mockReturnValue({
      enabled: true,
      sourceRoot: '/repo',
      expectedRef: 'origin/staging',
      requireClean: true,
      requireExpectedRef: true,
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    });
    mockValidateRuntimeSource.mockResolvedValue({ ...HEALTHY_SOURCE });
    mockEnsureWorkspaceRepo.mockResolvedValue(process.cwd());
    mockStartHeartbeat.mockReturnValue(vi.fn());
    mockOperatorLearningInit.mockResolvedValue(undefined);
    mockCloseOrphanedSessions.mockResolvedValue(0);
    mockHasActiveInteractiveSession.mockResolvedValue(false);
    mockStartInteractivePOSession.mockResolvedValue({
      ok: true,
      value: {
        id: 'po-session-1',
        endReason: 'explicit_close',
        needsDiscussionResolved: 0,
        summary: '',
      },
    });
    mockClassifyBatch.mockImplementation(
      async (_runtime: unknown, requests: Array<{ issueNumber: number }>) => ({
        results: requests.map((request) => ({
          issueNumber: request.issueNumber,
          classified: true,
          event: 'success:simple',
          complexity: 'simple',
          allocatedCost: 0,
        })),
        totalCost: 0,
        batchSequenceId: 'batch-test',
        status: 'complete',
      }),
    );
    mockCreateReviewScheduler.mockReturnValue({
      start: () => () => {},
      getStatus: () => ({}),
    });
    mockCreatePOAgent.mockReturnValue({
      start: vi.fn().mockReturnValue(vi.fn()),
      submitIdea: vi.fn().mockResolvedValue({
        id: 'idea-1',
        submittedBy: 'operator',
        description: 'test',
        status: 'pending',
        proposalId: null,
        createdAt: '2026-03-23T00:00:00Z',
      }),
    });
    mockCreateTechLeadScheduler.mockReturnValue({
      start: vi.fn().mockReturnValue(vi.fn()),
      stop: vi.fn(),
      triggerEvent: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ cyclesRun: 0, running: false }),
    });
    mockCreateCoordinator.mockReturnValue({
      start: vi.fn().mockReturnValue(vi.fn()),
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    phaseHandlerCalls.length = 0;
    process.env.GITHUB_TOKEN = originalEnv.GITHUB_TOKEN;
    process.env.RUNFORGE_DATABASE_URL = originalEnv.RUNFORGE_DATABASE_URL;
    process.env.ENCRYPTION_KEY = originalEnv.ENCRYPTION_KEY;
    process.env.DAEMON_DATA_BACKEND = originalEnv.DAEMON_DATA_BACKEND;
  });

  describe('T2.1 pauseReason', () => {
    it('defaults to null when the daemon is not paused, and /health is 200 ok', async () => {
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      expect(result.ok).toBe(true);
      const h = await handlersFromLastBoot();
      expect(h.getStatus()['paused']).toBe(false);
      expect(h.getStatus()['pauseReason']).toBeNull();
      expect(h.getHealth()).toEqual({ ok: true, degraded: false, reason: null });
    });

    it('a manual pause stamps pauseReason=manual and /health is 200 degraded (NOT 503)', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      const h = await handlersFromLastBoot();
      h.pause();
      expect(h.getStatus()['pauseReason']).toBe('manual');
      const health = h.getHealth();
      expect(health.ok).toBe(true);
      expect(health.degraded).toBe(true);
      expect(health.reason).toContain('manual');
    });

    it('a runtime-source preflight pause stamps pauseReason=runtime-source and /health is 503', async () => {
      mockValidateRuntimeSource.mockResolvedValueOnce({
        ...HEALTHY_SOURCE,
        healthy: false,
        clean: false,
        dirtyPaths: ['packages/daemon/src/control-plane/daemon.ts'],
        synchronized: false,
        action: 'pause',
        failureKind: 'dirty-runtime-source',
        message: 'Runtime source has uncommitted changes',
      });
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      const h = await handlersFromLastBoot();
      expect(h.getStatus()['paused']).toBe(true);
      expect(h.getStatus()['pauseReason']).toBe('runtime-source');
      expect(h.getHealth().ok).toBe(false);
    });
  });

  describe('T2.3 B2 governed-without-channel → warn + degraded (NOT refuse)', () => {
    it('a governed deployment with no alert channel boots, warns, and sets the degraded flag', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(
          makeConfig({
            webhooks: [],
            deployment: { id: 'dep-a', profile: makeDeploymentProfile() },
          }),
        ),
      );
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      expect(result.ok).toBe(true); // NOT refused
      expect(mockServerStart).toHaveBeenCalled();
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('NO configured alert channel'),
        ),
      ).toBe(true);
      const h = await handlersFromLastBoot();
      expect(h.getStatus()['alertChannelDegraded']).toBe(true);
      const health = h.getHealth();
      expect(health.ok).toBe(true);
      expect(health.degraded).toBe(true);
      expect(health.reason).toContain('alert-channel');
    });

    it('a governed deployment WITH an alert channel does not set the degraded flag', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(
          makeConfig({
            webhooks: ['https://hooks.example.com/x'],
            deployment: { id: 'dep-a', profile: makeDeploymentProfile() },
          }),
        ),
      );
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      expect(result.ok).toBe(true);
      const h = await handlersFromLastBoot();
      expect(h.getStatus()['alertChannelDegraded']).toBe(false);
      expect(h.getHealth()).toEqual({ ok: true, degraded: false, reason: null });
    });

    it('a NON-governed daemon with no channel is unaffected (no flag, no warn)', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(makeConfig({ webhooks: [], deployment: undefined })),
      );
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        decisionManager: makeDecisionManager('disabled'),
      });
      expect(result.ok).toBe(true);
      const h = await handlersFromLastBoot();
      expect(h.getStatus()['alertChannelDegraded']).toBe(false);
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('NO configured alert channel'),
        ),
      ).toBe(false);
    });
  });

  describe('T2.5 B5 watchdog → detect → self-pause + notify + 503 (slot held)', () => {
    it('a run-stall self-pauses (stuck), notifies once, flips /health to 503, and leaves activeRuns UNCHANGED', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(makeConfig({ webhooks: ['https://hooks.example.com/x'] })),
      );
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
        watchdog: {
          now: () => 10_000_000,
          intervalMs: 50,
          idleTimeoutMs: 1000,
          // A stalled active run: lastUpdatedAt far in the past.
          readSignals: async () => ({
            activeRunProgress: [{ issue: 1, lastUpdatedAt: 0 }],
            pollerSnapshots: [],
          }),
        },
      });

      const h = await handlersFromLastBoot();
      expect(h.getStatus()['paused']).toBe(false);
      expect(h.getStatus()['activeRuns']).toBe(0);
      const notifyCallsBefore = mockNotify.mock.calls.length;

      await vi.advanceTimersByTimeAsync(60);

      const status = h.getStatus();
      expect(status['paused']).toBe(true);
      expect(status['pauseReason']).toBe('stuck');
      expect(status['watchdogStall']).toMatchObject({ kind: 'run-stall' });
      // CRITICAL SAFETY: the watchdog must NOT decrement / mutate activeRuns.
      expect(status['activeRuns']).toBe(0);
      expect(h.getHealth().ok).toBe(false);

      // notify fired once for the stall.
      const stallNotifies = mockNotify.mock.calls
        .slice(notifyCallsBefore)
        .filter((c) => (c[1] as { event?: string })?.event === 'watchdog-stall');
      expect(stallNotifies.length).toBe(1);

      // A second watchdog cycle must not re-fire (already paused).
      await vi.advanceTimersByTimeAsync(60);
      const stillOne = mockNotify.mock.calls.filter(
        (c) => (c[1] as { event?: string })?.event === 'watchdog-stall',
      );
      expect(stillOne.length).toBe(1);
    });

    it('a progressing run (fresh lastUpdatedAt) is NOT flagged', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
        watchdog: {
          now: () => 10_000_000,
          intervalMs: 50,
          idleTimeoutMs: 1000,
          readSignals: async () => ({
            activeRunProgress: [{ issue: 1, lastUpdatedAt: 10_000_000 - 10 }],
            pollerSnapshots: [],
          }),
        },
      });
      const h = await handlersFromLastBoot();
      await vi.advanceTimersByTimeAsync(120);
      expect(h.getStatus()['paused']).toBe(false);
      expect(h.getStatus()['watchdogStall']).toBeNull();
    });

    it('a tick-stall (poll never settled) self-pauses', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
        watchdog: {
          now: () => 10_000_000,
          intervalMs: 50,
          idleTimeoutMs: 1000,
          readSignals: async () => ({
            activeRunProgress: [],
            pollerSnapshots: [
              {
                repoId: 'r1',
                owner: 'o',
                name: 'n',
                pollInProgress: true,
                pollStartedAt: 0,
              },
            ],
          }),
        },
      });
      const h = await handlersFromLastBoot();
      await vi.advanceTimersByTimeAsync(60);
      const status = h.getStatus();
      expect(status['paused']).toBe(true);
      expect(status['pauseReason']).toBe('stuck');
      expect(status['watchdogStall']).toMatchObject({ kind: 'tick-stall' });
    });

    it('a run-stall on a REAL claimed run preserves the held slot (activeRuns stays 1, NOT decremented)', async () => {
      // Drive an actual claimed run so activeRuns=1 (a 0→0 assertion would prove
      // nothing). A pending runPipeline keeps the run active; the watchdog
      // interval is set ABOVE the poll interval so the run is claimed BEFORE the
      // first watchdog tick.
      mockLoadConfig.mockResolvedValue(
        ok(makeConfig({ webhooks: ['https://hooks.example.com/x'] })),
      );
      mockDetector.detectReadyWork.mockResolvedValue(
        ok([makeWorkRequest({ issueNumber: 1 })]),
      );
      let resolveRun!: (v: unknown) => void;
      mockRunPipeline.mockReturnValue(
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
        watchdog: {
          now: () => 10_000_000,
          intervalMs: 40_000, // > pollIntervalMs (30000): claim happens first
          idleTimeoutMs: 1000,
          readSignals: async () => ({
            activeRunProgress: [{ issue: 1, lastUpdatedAt: 0 }], // stalled
            pollerSnapshots: [],
          }),
        },
      });
      const h = await handlersFromLastBoot();

      // First poll claims the run; runPipeline stays pending → activeRuns=1.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.getStatus()['activeRuns']).toBe(1);
      expect(h.getStatus()['paused']).toBe(false);

      // Now the watchdog ticks (at 40_000) and detects the run-stall.
      await vi.advanceTimersByTimeAsync(40_000);
      const status = h.getStatus();
      expect(status['paused']).toBe(true);
      expect(status['pauseReason']).toBe('stuck');
      expect(status['watchdogStall']).toMatchObject({ kind: 'run-stall' });
      // CRITICAL SAFETY: the held concurrency slot is preserved — NOT decremented.
      expect(status['activeRuns']).toBe(1);

      // cleanup: let the pending run settle so afterEach doesn't leak it.
      resolveRun({ outcome: 'complete' });
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  describe('T2.6 /health repoTickStale aligns with the watchdog idle-timeout (no false 503)', () => {
    it('an in-flight poll older than 3 poll-intervals but younger than the idle-timeout is NOT 503', async () => {
      // Regression for the false-503: the OLD threshold (3 * pollIntervalMs ≈ 90s)
      // would 503 a legitimate long poll (a poll can await preClassifyReadyWork's
      // 3h-capped classifier). Default config: pollInterval 30s, watchdog
      // idle-timeout 3h15m, default Date.now clock (faked) shared by the poll
      // start-time and getHealth. A hanging poll keeps pollInProgress=true.
      mockDetector.detectReadyWork.mockReturnValue(
        new Promise(() => {
          /* never settles → poll stays in flight */
        }),
      );

      const { startDaemon } = await loadDaemon();
      // No watchdog opts → real default clock (fake-timer controlled), default
      // idle-timeout (3h15m), watchdog interval = pollIntervalMs.
      await startDaemon('config.json');
      const h = await handlersFromLastBoot();

      // Start a poll, then let it sit in flight for 100s — well past the old 90s
      // threshold, far below the 3h15m idle-timeout.
      await vi.advanceTimersByTimeAsync(30_000); // first poll fires + hangs
      await vi.advanceTimersByTimeAsync(100_000); // +100s in flight

      const health = h.getHealth();
      expect(health.ok).toBe(true); // NOT 503 — the long poll is legitimate
      expect(health.degraded).toBe(false);
      expect(h.getStatus()['paused']).toBe(false); // watchdog hasn't flagged it either
    });
  });

  describe('T2.5 watchdog idle-timeout is clamped DOWNWARD-only (config cannot weaken it)', () => {
    it('an UPWARD config override is clamped to the default ceiling', async () => {
      // config asks for 12h; the safety net must not be weakened past the default.
      const twelveHours = 12 * 60 * 60 * 1000;
      mockLoadConfig.mockResolvedValue(
        ok(
          makeConfig({
            webhooks: ['https://hooks.example.com/x'],
            watchdogIdleTimeoutMs: twelveHours,
          }),
        ),
      );
      // now is 4h past a run's last progress: BELOW the requested 12h, but ABOVE
      // the default 3h15m ceiling → the clamp means this DOES flag a stall.
      const fourHoursMs = 4 * 60 * 60 * 1000;
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
        watchdog: {
          now: () => fourHoursMs,
          intervalMs: 50,
          // idleTimeoutMs intentionally NOT injected → the daemon derives it from
          // config (clamped). readSignals: a run last-progressed at t=0.
          readSignals: async () => ({
            activeRunProgress: [{ issue: 1, lastUpdatedAt: 0 }],
            pollerSnapshots: [],
          }),
        },
      });
      const h = await handlersFromLastBoot();
      await vi.advanceTimersByTimeAsync(60);
      const status = h.getStatus();
      // If the upward override had won (12h), 4h idle would NOT flag. It DID flag
      // → the timeout was clamped down to the 3h15m default.
      expect(status['paused']).toBe(true);
      expect(status['pauseReason']).toBe('stuck');
      expect(status['watchdogStall']).toMatchObject({ kind: 'run-stall' });
    });
  });

  describe('T2.7 crash handlers installed inside startDaemon', () => {
    it('registers process uncaughtException + unhandledRejection handlers', async () => {
      const onSpy = process.on as unknown as ReturnType<typeof vi.fn>;
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      const events = onSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain('uncaughtException');
      expect(events).toContain('unhandledRejection');
    });
  });

  describe('T2.7 drain completion: shutdown waits for an active run, then completes', () => {
    it('a drain with an active run defers shutdown until the run finishes (finishActiveRun → shutdown)', async () => {
      // This is the daemon-side mechanism the crash handler awaits via
      // `shutdownComplete`: enterDrainMode does NOT shut down while a run is
      // active; the run's completion (finishActiveRun) drives shutdown(). A
      // 0→exit-immediately bug would close the server right away.
      mockDetector.detectReadyWork.mockResolvedValue(
        ok([makeWorkRequest({ issueNumber: 1 })]),
      );
      let resolveRun!: (v: unknown) => void;
      mockRunPipeline.mockReturnValue(
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json', {
        decisionManager: makeDecisionManager('available'),
      });
      const h = await handlersFromLastBoot();
      const { drain } = vi.mocked(
        (await import('./server.js')).createControlServer,
      ).mock.lastCall![1];

      // Claim a run → activeRuns=1, runPipeline pending.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.getStatus()['activeRuns']).toBe(1);

      // Enter drain while the run is active → shutdown must NOT fire yet.
      drain();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.getStatus()['draining']).toBe(true);
      expect(mockServer.close).not.toHaveBeenCalled();

      // The run completes → finishActiveRun decrements to 0 → shutdown() runs.
      resolveRun({ outcome: 'complete' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockServer.close).toHaveBeenCalled();
    });
  });
});
