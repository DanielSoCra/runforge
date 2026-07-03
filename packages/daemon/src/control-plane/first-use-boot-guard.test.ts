// packages/daemon/src/control-plane/first-use-boot-guard.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok } from '../lib/result.js';
import type { Config } from '../config.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';

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

vi.mock('../knowledge/gotcha-store.js', () => ({
  GotchaStore: class {},
}));

vi.mock('../knowledge/knowledge-store.js', () => ({
  KnowledgeStore: class {},
}));

vi.mock('../knowledge/policy-registry.js', () => ({
  DEFAULT_POLICIES: {},
}));

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

vi.mock('@auto-claude/db', () => ({
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
    staticAnalysis: {
      maxComplexity: 15,
      maxFunctionLength: 50,
      maxFileSize: 500,
    },
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
  warmup: {
    threshold: 10,
    regressionThreshold: 3,
    samplingRate: 0.1,
    minSamplingRate: 0.01,
  },
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

function makeDeploymentProfile(overrides?: Record<string, unknown>): Record<string, unknown> {
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
    reader: {
      listRanked: vi.fn(),
      detail: vi.fn(),
    },
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
    ledger: vi.fn(() => {
      if (state === 'disabled') throw new Error('decision index disabled');
      if (state === 'unavailable') {
        throw new Error('decision index unavailable');
      }
      return ledger;
    }),
    protectedStore: vi.fn(() => {
      if (state !== 'available') {
        throw new Error(
          state === 'disabled'
            ? 'decision index disabled'
            : 'decision index unavailable',
        );
      }
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

describe('first-use boot guard', () => {
  const originalEnv = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    AUTO_CLAUDE_DATABASE_URL: process.env.AUTO_CLAUDE_DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    DAEMON_DATA_BACKEND: process.env.DAEMON_DATA_BACKEND,
  };

  beforeEach(() => {
    vi.useFakeTimers();

    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.AUTO_CLAUDE_DATABASE_URL = 'postgres://test';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64url');
    process.env.DAEMON_DATA_BACKEND = 'postgres';

    vi.spyOn(process, 'on').mockImplementation(((
      _event: string,
      _handler: () => Promise<void>,
    ) => process) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    mockNotify.mockResolvedValue(undefined);
    mockStateMgr.initialize.mockResolvedValue(undefined);
    mockStateMgr.saveRunState.mockResolvedValue(undefined);
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
    mockValidateRuntimeSource.mockResolvedValue({
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
    });
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
    process.env.AUTO_CLAUDE_DATABASE_URL =
      originalEnv.AUTO_CLAUDE_DATABASE_URL;
    process.env.ENCRYPTION_KEY = originalEnv.ENCRYPTION_KEY;
    process.env.DAEMON_DATA_BACKEND = originalEnv.DAEMON_DATA_BACKEND;
  });

  it('refuses boot for a governed deployment when the decision index is disabled', async () => {
    mockLoadConfig.mockResolvedValue(
      ok(
        makeConfig({
          deployment: {
            id: 'dep-a',
            profile: makeDeploymentProfile(),
          },
        }),
      ),
    );

    const { startDaemon } = await loadDaemon();
    const result = await startDaemon('config.json', {
      decisionManager: makeDecisionManager('disabled'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(
        /AUTO_CLAUDE_DECISION_INDEX_ENABLED/,
      );
      expect(result.error.message).toMatch(/enable|set/i);
    }
    expect(mockServerStart).not.toHaveBeenCalled();
  });

  it('refuses boot for a governed deployment when the enabled decision index is unreachable', async () => {
    mockLoadConfig.mockResolvedValue(
      ok(
        makeConfig({
          deployment: {
            id: 'dep-a',
            profile: makeDeploymentProfile(),
          },
        }),
      ),
    );

    const { startDaemon } = await loadDaemon();
    const result = await startDaemon('config.json', {
      decisionManager: makeDecisionManager('unavailable'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/decision index/i);
      expect(result.error.message).toMatch(/unreachable/i);
    }
    expect(mockServerStart).not.toHaveBeenCalled();
  });

  it('refuses boot for a governed deployment when deployment registration fails', async () => {
    mockLoadConfig.mockResolvedValue(
      ok(
        makeConfig({
          deployment: {
            id: 'dep-a',
            profile: makeDeploymentProfile({ deploymentName: 'typo' }),
          },
        }),
      ),
    );

    const { startDaemon } = await loadDaemon();
    const result = await startDaemon('config.json', {
      decisionManager: makeDecisionManager('available'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/registration|register/i);
      expect(result.error.message).toMatch(/deploymentName/);
    }
    expect(mockServerStart).not.toHaveBeenCalled();
  });

  it('allows a non-governed daemon to boot when the decision index is disabled', async () => {
    mockLoadConfig.mockResolvedValue(ok(makeConfig({ deployment: undefined })));

    const { startDaemon } = await loadDaemon();
    const result = await startDaemon('config.json', {
      decisionManager: makeDecisionManager('disabled'),
    });

    expect(result.ok).toBe(true);
    expect(mockServerStart).toHaveBeenCalled();
  });

  it('allows a governed daemon to boot when the decision index is available and registration succeeds', async () => {
    mockLoadConfig.mockResolvedValue(
      ok(
        makeConfig({
          deployment: {
            id: 'dep-a',
            profile: makeDeploymentProfile(),
          },
        }),
      ),
    );

    const { startDaemon } = await loadDaemon();
    const result = await startDaemon('config.json', {
      decisionManager: makeDecisionManager('available'),
    });

    expect(result.ok).toBe(true);
    expect(mockServerStart).toHaveBeenCalled();
  });
});
