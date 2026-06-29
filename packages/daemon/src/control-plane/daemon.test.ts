// src/control-plane/daemon.test.ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err } from '../lib/result.js';
import type { Config } from '../config.js';
import type { WorkRequest } from '../types.js';
import { DecisionIndexManager } from './decision-escalation/manager.js';
import { buildL2GateRequest } from './decision-escalation/build-request.js';
import { buildMergeDecisionRequest } from './merge-decision/build-request.js';
import type { MergeDecision } from './merge-decision/types.js';
import {
  createFakeDecisionManager,
  asDecisionManager,
} from './decision-escalation/__fixtures__/fake-decision-ledger.js';
import {
  DECISION_DB_URL,
  REAL_PG,
  makeSchemaSerializer,
} from './decision-escalation/__fixtures__/pg-test-harness.js';

// --- Hoisted mocks (vi.mock factories are hoisted above all other code) ---

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
  knowledgeStoreCtorArgs,
  mockOctokit,
  mockSpawnSession,
  mockValidatePromptContracts,
  mockClassifyBatch,
  mockBuildRuntimeSourcePolicy,
  mockValidateRuntimeSource,
  mockGetStartPhase,
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
      if (cb) cb();
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
    listEnabledRepos: vi.fn().mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'repo-id',
          owner: 'test-owner',
          name: 'test-repo',
          poll_interval_ms: null,
          connection_id: null,
        },
      ],
    }),
    upsertRepo: vi.fn().mockResolvedValue({ ok: true, value: 'repo-id' }),
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
  mockCreatePOAgent: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnValue(vi.fn()),
    submitIdea: vi.fn().mockResolvedValue({
      id: 'idea-1',
      submittedBy: 'operator',
      description: 'test',
      status: 'pending',
      proposalId: null,
      createdAt: '2026-03-23T00:00:00Z',
    }),
  }),
  mockCreateTechLeadScheduler: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnValue(vi.fn()),
    stop: vi.fn(),
    triggerEvent: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ cyclesRun: 0, running: false }),
  }),
  mockCreateCoordinator: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnValue(vi.fn()),
  }),
  knowledgeStoreCtorArgs: [] as unknown[],
  mockOctokit: {
    issues: {
      get: vi.fn().mockResolvedValue({ data: { labels: [], state: 'open' } }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  mockSpawnSession: vi.fn(),
  mockValidatePromptContracts: vi.fn(),
  mockClassifyBatch: vi.fn(),
  mockBuildRuntimeSourcePolicy: vi.fn(),
  mockValidateRuntimeSource: vi.fn(),
  mockGetStartPhase: vi.fn(),
  mockHasActiveInteractiveSession: vi.fn().mockResolvedValue(false),
  mockStartInteractivePOSession: vi.fn().mockResolvedValue({
    ok: true,
    value: {
      id: 'po-session-1',
      endReason: 'explicit_close',
      needsDiscussionResolved: 0,
      summary: '',
    },
  }),
  mockCloseOrphanedSessions: vi.fn().mockResolvedValue(0),
}));

// --- Module mocks (use classes for constructors to work with `new`) ---

vi.mock('./state.js', () => {
  return {
    StateManager: class {
      initialize = mockStateMgr.initialize;
      saveRunState = mockStateMgr.saveRunState;
      findIncompleteRuns = mockStateMgr.findIncompleteRuns;
      findParkedRuns = mockStateMgr.findParkedRuns;
    },
  };
});
vi.mock('../session-runtime/cost.js', () => {
  return {
    CostTracker: class {
      getDailyCost = mockCostTracker.getDailyCost;
      maybeResetDaily = mockCostTracker.maybeResetDaily;
    },
  };
});
vi.mock('../session-runtime/runtime.js', () => {
  return {
    SessionRuntime: class {
      spawnSession = mockSpawnSession;
      getProviderRegistry = () => ({
        markSmokeProof: vi.fn(),
        markSmokeFailed: vi.fn(),
      });
    },
    preloadPromptCache: async () => 0,
  };
});
const mockKillAllManagedProcessGroups = vi.hoisted(() => vi.fn(() => 0));
vi.mock('../session-runtime/managed-processes.js', () => {
  return {
    killAllManagedProcessGroups: mockKillAllManagedProcessGroups,
    managedProcessCount: vi.fn(() => 0),
    registerManagedProcess: vi.fn(),
    unregisterManagedProcess: vi.fn(),
    killProcessGroup: vi.fn(),
  };
});
vi.mock('../knowledge/gotcha-store.js', () => {
  return { GotchaStore: class {} };
});
vi.mock('../knowledge/knowledge-store.js', () => {
  return {
    KnowledgeStore: class {
      constructor(...args: unknown[]) {
        knowledgeStoreCtorArgs.length = 0;
        knowledgeStoreCtorArgs.push(...args);
      }
    },
  };
});
vi.mock('../knowledge/policy-registry.js', () => ({
  DEFAULT_POLICIES: {},
}));
vi.mock('../knowledge/prompt-contracts.js', () => ({
  validatePromptContracts: mockValidatePromptContracts,
}));
vi.mock('../implementation/coordinator.js', () => {
  return { ImplementationCoordinator: class {} };
});
vi.mock('./remote-control.js', () => {
  return {
    RemoteControlManager: class {
      start = mockRemoteControl.start;
      stop = mockRemoteControl.stop;
      restart = mockRemoteControl.restart;
      getState = mockRemoteControl.getState;
    },
  };
});
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
vi.mock('../data/config-reader.js', () => {
  return {
    PostgresConfigReader: class {
      start = mockConfigReader.start;
      stop = mockConfigReader.stop;
      getGlobalConfig = mockConfigReader.getGlobalConfig;
      getRepoConfig = mockConfigReader.getRepoConfig;
      tryFetch = mockConfigReader.tryFetch;
      isStartupDegraded = mockConfigReader.isStartupDegraded;
      getLastConfigError = mockConfigReader.getLastConfigError;
    },
  };
});
vi.mock('../data/run-writer.js', () => {
  return {
    PostgresRunWriter: class {
      insertRun = mockRunWriter.insertRun;
      upsertRun = mockRunWriter.upsertRun;
      writeCostEvent = mockRunWriter.writeCostEvent;
    },
    toDbOutcome: (o: string) => o,
  };
});
vi.mock('../data/repo-source.js', () => {
  return {
    PostgresRepoDataSource: class {
      listEnabledRepos = mockRepoSource.listEnabledRepos;
      upsertRepo = mockRepoSource.upsertRepo;
      resolveConnectionToken = mockRepoSource.resolveConnectionToken;
    },
  };
});
vi.mock('../data/run-history.js', () => {
  return {
    PostgresRunHistory: class {
      countStuckRunsForIssue = mockRunHistory.countStuckRunsForIssue;
      markInProgressRunsStuck = mockRunHistory.markInProgressRunsStuck;
    },
  };
});
vi.mock('@octokit/rest', () => {
  return {
    Octokit: class {
      issues = mockOctokit.issues;
    },
  };
});
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

// --- Helpers ---

const makeConfig = (overrides?: Partial<Config>): Config => ({
  controlPort: 3847,
  controlHost: '127.0.0.1',
  pollIntervalMs: 30000,
  maxConcurrentRuns: 1,
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
    allowSelfRepair: false,
    onUnhealthy: 'pause',
    ignoredDirtyPaths: [
      'state/',
      'workspaces/',
      '.claude/scheduled_tasks.lock',
    ],
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

const makeWorkRequest = (overrides?: Partial<WorkRequest>): WorkRequest => ({
  issueNumber: 42,
  title: 'Test issue',
  body: 'Fix the thing',
  labels: ['ready'],
  specRefs: [],
  ...overrides,
});

// daemon.ts's daily run-count module state (dailyRunState) is reset via the exported
// __resetDailyRunStateForTests() instead of vi.resetModules()+re-import, so the large
// daemon.js graph is imported ONCE (warm) and reused across the suite rather than cold
// esbuild-transformed per test. That per-test cold re-import is what flaked CI under
// shared-runner contention (RC-3, #770); with the resettable holder it is gone.
// Hoisted vi.mock() factories stay applied across the cached import, and per-test mock
// state is reset by beforeEach/afterEach — so the run-count holder is the only daemon.ts
// state needing an explicit per-test reset. (The one test that uses vi.doMock to swap a
// dependency must still re-import cold — it does so inline, then evicts it.)
//
// FORWARD-INVARIANT (codex review, #790): warm-reuse is safe ONLY because every OTHER
// module-level mutable singleton reachable from the daemon.js graph is neutralized for
// tests — promptCache (session-runtime/runtime.ts), `active` (managed-processes.ts) and
// repoGitLock (control-plane/phases.ts) are hoisted-vi.mock()'d out, and governanceCache
// (session-runtime/governance-context.ts) is short-circuited in test mode. If you add a
// NEW module-scope mutable singleton to that graph, neutralize it the same way (a hoisted
// vi.mock, a test-mode bypass, or its own __resetForTests() called here) — otherwise it
// leaks across the 100+ warm loadDaemon() calls and reintroduces an RC-3-class flake.
const loadDaemon = async () => {
  const mod = await import('./daemon.js');
  mod.__resetDailyRunStateForTests();
  return mod;
};

/**
 * The decision-index Postgres suites fake ONLY the setInterval poll loop; the real
 * postgres-js writer runs on REAL setTimeout/setImmediate + sockets. advanceTimers-
 * ByTimeAsync fires the faked poll but returns before those real round-trips settle,
 * so drain the real event loop until the daemon's async resume chain has finished
 * before asserting on its Postgres-backed effects.
 */
async function settleRealAsync(turns = 60): Promise<void> {
  // Use a small REAL delay per turn (setTimeout is unfaked in these suites) so each
  // turn guarantees a full event-loop iteration — enough for the ~10 sequential
  // localhost Postgres round-trips of a full answer→advanceToResumed resume chain.
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('daemon', () => {
  const signalHandlers: Record<string, () => Promise<void>> = {};

  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure all required boot env vars are set for happy-path tests (gap #7)
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    process.env.AUTO_CLAUDE_DATABASE_URL = 'postgres://test';
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64url');
    // Capture signal handlers.
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: () => Promise<void>,
    ) => {
      signalHandlers[event] = handler;
      return process;
    }) as any);
    // Reset all mock state
    mockLoadConfig.mockResolvedValue(ok(makeConfig()));
    mockDetector.detectReadyWork.mockResolvedValue(ok([]));
    mockDetector.detectBugFixWork.mockResolvedValue(ok(null));
    mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(null));
    mockDetector.claimWork.mockResolvedValue(ok(undefined));
    mockDetector.claimBugFixWork.mockResolvedValue(ok(undefined));
    mockDetector.claimFeaturePipelineWork.mockResolvedValue(ok(undefined));
    mockDetector.markStuck.mockResolvedValue(ok(undefined));
    mockSelectVariant.mockReturnValue('feature');
    mockGetStartPhase.mockReturnValue('detect'); // default: all variants start at 'detect'
    mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
    mockServerStart.mockResolvedValue(ok(undefined));
    mockDegradedStart.mockResolvedValue(ok(undefined));
    mockDegradedClose.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
    mockStateMgr.initialize.mockResolvedValue(undefined);
    mockStateMgr.saveRunState.mockResolvedValue(undefined);
    mockStateMgr.findIncompleteRuns.mockResolvedValue([]);
    mockStateMgr.findParkedRuns.mockResolvedValue([]);
    mockOctokit.issues.get.mockResolvedValue({
      data: { labels: [], state: 'open' },
    });
    mockOctokit.issues.removeLabel.mockResolvedValue(undefined);
    mockOctokit.issues.addLabels.mockResolvedValue(undefined);
    mockOctokit.issues.listComments.mockResolvedValue({ data: [] });
    mockRemoteControl.stop.mockResolvedValue(undefined);
    mockCostTracker.getDailyCost.mockReturnValue(0);
    mockRunWriter.insertRun.mockResolvedValue(undefined);
    mockRunWriter.upsertRun.mockResolvedValue(undefined);
    mockRunWriter.writeCostEvent.mockResolvedValue(undefined);
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
    mockHasActiveInteractiveSession.mockResolvedValue(false);
    mockCloseOrphanedSessions.mockResolvedValue(0);
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
    mockValidatePromptContracts.mockResolvedValue(ok({ checked: 3 }));
    mockBuildRuntimeSourcePolicy.mockReturnValue({
      enabled: true,
      sourceRoot: '/repo',
      expectedRef: 'origin/staging',
      requireClean: true,
      requireExpectedRef: true,
      allowSelfRepair: false,
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
      checkedAt: '2026-05-14T00:00:00.000Z',
      action: 'pause',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clear all pending timers/intervals BEFORE switching to real timers
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // vi.restoreAllMocks only restores spies, not hoisted vi.fn() — clear them explicitly
    for (const mock of [
      mockDetector.detectReadyWork,
      mockDetector.detectBugFixWork,
      mockDetector.detectFeaturePipelineWork,
      mockDetector.claimWork,
      mockDetector.claimBugFixWork,
      mockDetector.claimFeaturePipelineWork,
      mockDetector.markStuck,
      mockRunPipeline,
      mockNotify,
      mockServerStart,
      mockDegradedStart,
      mockDegradedClose,
      mockLoadConfig,
      mockStateMgr.initialize,
      mockStateMgr.saveRunState,
      mockStateMgr.findIncompleteRuns,
      mockStateMgr.findParkedRuns,
      mockOctokit.issues.get,
      mockOctokit.issues.removeLabel,
      mockOctokit.issues.addLabels,
      mockOctokit.issues.listComments,
      mockServer.close,
      mockRemoteControl.start,
      mockRemoteControl.stop,
      mockCostTracker.getDailyCost,
      mockCostTracker.maybeResetDaily,
      mockRunWriter.insertRun,
      mockRunWriter.upsertRun,
      mockRunWriter.writeCostEvent,
      mockClassifyBatch,
      mockConfigReader.start,
      mockConfigReader.stop,
      mockConfigReader.getGlobalConfig,
      mockConfigReader.getRepoConfig,
      mockRepoSource.listEnabledRepos,
      mockRepoSource.upsertRepo,
      mockRepoSource.resolveConnectionToken,
      mockRunHistory.countStuckRunsForIssue,
      mockRunHistory.markInProgressRunsStuck,
      mockDbSqlEnd,
      mockSelectVariant,
      mockGetStartPhase,
      mockCreateReviewScheduler,
      mockCreatePOAgent,
      mockCreateTechLeadScheduler,
      mockCreateCoordinator,
      mockSpawnSession,
      mockValidatePromptContracts,
      mockBuildRuntimeSourcePolicy,
      mockValidateRuntimeSource,
      mockHasActiveInteractiveSession,
      mockStartInteractivePOSession,
      mockCloseOrphanedSessions,
    ]) {
      mock.mockClear();
    }
    phaseHandlerCalls.length = 0;
    for (const key in signalHandlers) delete signalHandlers[key];
  });

  it('RC-3 root-cause guard: loadDaemon imports warm and does NOT reset modules', () => {
    // The whole point of the dailyRunState holder + __resetDailyRunStateForTests is
    // that loadDaemon() stops cold-re-importing daemon.js per test (RC-3, #770). If
    // someone re-adds vi.resetModules() to the helper, the 131 cold imports come back.
    // (The single vi.doMock test still resets modules inline — that's intentional and
    // not covered by this helper-scoped guard.)
    expect(loadDaemon.toString()).not.toMatch(/resetModules/);
    expect(loadDaemon.toString()).toContain('__resetDailyRunStateForTests');
  });

  describe('startDaemon', () => {
    it('returns error when GITHUB_TOKEN is not set', async () => {
      const originalToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        const { startDaemon } = await loadDaemon();
        const result = await startDaemon('config.json');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('GITHUB_TOKEN');
        }
        expect(mockLoadConfig).not.toHaveBeenCalled();
      } finally {
        process.env.GITHUB_TOKEN = originalToken;
      }
    });

    it('returns error when config loading fails', async () => {
      mockLoadConfig.mockResolvedValue(err(new Error('bad config')));

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('bad-path.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('bad config');
      }
    });

    it('initializes StateManager on valid config', async () => {
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
      expect(mockStateMgr.initialize).toHaveBeenCalled();
    });

    it('returns ok and starts control server in Postgres mode', async () => {
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
      expect(mockServerStart).toHaveBeenCalled();
    });

    it('degrades gracefully (returns err, does not abort boot) when the decision-escalation block throws (FIX 1)', async () => {
      // FIX 1: the decision-index construct/init/boot-reconcile block sits inside
      // the graceful boot try/catch. A throw there (e.g. key generation on a
      // read-only/full stateDir) must surface as a `return err(...)` Result, NOT
      // as an unhandled exception that aborts daemon boot.
      const throwingManager = {
        isEnabled: () => true,
        init: async () => {
          throw new Error('stateDir not writable: EROFS');
        },
        close: async () => undefined,
        ledger: () => {
          throw new Error('decision index unavailable');
        },
      } as unknown as DecisionIndexManager;

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        decisionManager: throwingManager,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('EROFS');
      }
      // Boot aborted gracefully before the control server bound.
      expect(mockServerStart).not.toHaveBeenCalled();
    });

    it('rejects hostname controlHost from config before starting control server (#248)', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(makeConfig({ controlHost: 'my-server.local' })),
      );

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('controlHost');
        expect(result.error.message).toContain('valid IPv4 address');
      }
      expect(mockServerStart).not.toHaveBeenCalled();
    });

    it('returns error when control server fails to start', async () => {
      mockServerStart.mockResolvedValue(err(new Error('EADDRINUSE')));

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('EADDRINUSE');
      }
      // Cleanup should have been called
      expect(mockRemoteControl.stop).toHaveBeenCalled();
    });

    it('starts in Postgres mode when config.repo is missing', async () => {
      mockLoadConfig.mockResolvedValue(ok(makeConfig({ repo: undefined })));

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
      expect(mockServerStart).toHaveBeenCalled();
    });

    it('registers SIGTERM and SIGINT shutdown handlers', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(signalHandlers['SIGTERM']).toBeDefined();
      expect(signalHandlers['SIGINT']).toBeDefined();
    });

    it('registers a SIGUSR2 force-kill handler (immediate, not drain)', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // SIGTERM/SIGINT drain; SIGUSR2 is the separate hard-kill path for a
      // watched pilot so the operator can stop everything within seconds.
      expect(signalHandlers['SIGUSR2']).toBeDefined();
    });

    it('SIGUSR2 SIGKILLs active worker process groups, then exits', async () => {
      mockKillAllManagedProcessGroups.mockClear();
      mockKillAllManagedProcessGroups.mockReturnValue(2);
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(signalHandlers['SIGUSR2']).toBeDefined();
      await signalHandlers['SIGUSR2']!();

      // Force-kill child worker groups (SIGKILL) and then exit the daemon —
      // it does NOT wait for active runs to drain.
      expect(mockKillAllManagedProcessGroups).toHaveBeenCalledWith('SIGKILL');
      expect(exitSpy).toHaveBeenCalled();

      exitSpy.mockRestore();
    });

    it('starts RemoteControlManager when remoteControl.enabled is true (opt-in)', async () => {
      mockLoadConfig.mockResolvedValue(
        ok(makeConfig({ remoteControl: { enabled: true } })),
      );
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockRemoteControl.start).toHaveBeenCalled();
    });

    it('does NOT start RemoteControlManager by default (off in autonomous container)', async () => {
      // makeConfig() defaults remoteControl.enabled to false.
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockRemoteControl.start).not.toHaveBeenCalled();
    });

    it('aborts startup when smoke-proof admission fails a required provider', async () => {
      const failingAdapter = {
        spawn: vi.fn().mockResolvedValue(
          err({ message: 'spawn codex ENOENT' }),
        ),
        resume: vi.fn(),
        abort: vi.fn(),
        capabilities: vi.fn().mockReturnValue({
          nativeGuardHooks: false,
          structuredOutput: false,
          exactCostReporting: false,
          sessionContinuation: false,
        }),
      };
      // vi.doMock (unlike hoisted vi.mock) only affects the NEXT import, so this test
      // re-imports daemon.js cold (vi.resetModules + import) to pick up the failing
      // adapter — the warm cached loadDaemon() would miss it. This is the one carve-out
      // from the RC-3 warm-import change. The try/finally is load-bearing: the finally
      // doUnmock + vi.resetModules() EVICTS this doMock-bound daemon.js from the module
      // cache so the next warm loadDaemon() re-imports a clean graph. Without it the
      // next test could inherit a daemon.js still wired to the failing adapter — a
      // latent, order-dependent leak (codex review, 2026-06-24): it does not surface in
      // the current suite, but the eviction makes the carve-out order-independent. A
      // fresh import also gets fresh dailyRunState, so no __resetDailyRunStateForTests().
      try {
        vi.doMock('../session-runtime/adapters/index.js', () => ({
          createProviderAdapter: vi.fn().mockReturnValue(failingAdapter),
          createAdapter: vi.fn(),
          CliAdapter: class {},
          CodexCliAdapter: class {},
          PiCliAdapter: class {},
        }));

        mockLoadConfig.mockResolvedValue(
          ok(
            makeConfig({
              providers: {
                defaultProvider: 'codex-impl',
                fallbackChain: [],
                requireSmokeProof: true,
                definitions: {
                  'codex-impl': {
                    name: 'codex-impl',
                    adapterClass: 'process-based',
                    providerKind: 'codex-cli',
                    supportedModelTiers: ['higher-capability'],
                    required: true,
                    cliTool: 'codex',
                    model: 'gpt-5.5',
                    executionFlags: [],
                    env: {},
                  },
                },
              },
            }),
          ),
        );

        vi.resetModules();
        const { startDaemon } = await import('./daemon.js');
        const result = await startDaemon('config.json');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('codex-impl');
          expect(result.error.message).toContain('smoke admission');
        }
        expect(mockServerStart).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock('../session-runtime/adapters/index.js');
        // Evict the doMock-bound daemon.js so the next warm loadDaemon() is clean.
        vi.resetModules();
      }
    });

    // --- gap #7 tests: consolidated env validation at startDaemon ---
    it('startDaemon validates all required boot env vars and reports all missing at once', async () => {
      const originalDb = process.env.AUTO_CLAUDE_DATABASE_URL;
      const originalKey = process.env.ENCRYPTION_KEY;
      delete process.env.AUTO_CLAUDE_DATABASE_URL;
      delete process.env.ENCRYPTION_KEY;
      try {
        const { startDaemon } = await loadDaemon();
        const result = await startDaemon('config.json');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('AUTO_CLAUDE_DATABASE_URL');
          expect(result.error.message).toContain('ENCRYPTION_KEY');
        }
        // Env validation runs before config load (step 0)
        expect(mockLoadConfig).not.toHaveBeenCalled();
        expect(mockServerStart).not.toHaveBeenCalled();
      } finally {
        process.env.AUTO_CLAUDE_DATABASE_URL = originalDb;
        process.env.ENCRYPTION_KEY = originalKey;
      }
    });

    it('startDaemon reports all three required vars when all are missing', async () => {
      const origToken = process.env.GITHUB_TOKEN;
      const origDb = process.env.AUTO_CLAUDE_DATABASE_URL;
      const origKey = process.env.ENCRYPTION_KEY;
      delete process.env.GITHUB_TOKEN;
      delete process.env.AUTO_CLAUDE_DATABASE_URL;
      delete process.env.ENCRYPTION_KEY;
      try {
        const { startDaemon } = await loadDaemon();
        const result = await startDaemon('config.json');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('GITHUB_TOKEN');
          expect(result.error.message).toContain('AUTO_CLAUDE_DATABASE_URL');
          expect(result.error.message).toContain('ENCRYPTION_KEY');
        }
        expect(mockLoadConfig).not.toHaveBeenCalled();
        expect(mockServerStart).not.toHaveBeenCalled();
      } finally {
        process.env.GITHUB_TOKEN = origToken;
        process.env.AUTO_CLAUDE_DATABASE_URL = origDb;
        process.env.ENCRYPTION_KEY = origKey;
      }
    });
  });

  describe('degraded startup (DB-outage resilience)', () => {
    const unreachable = {
      ok: false as const,
      error: {
        category: 'unreachable' as const,
        cause: {
          class: 'PostgresError',
          code: 'ECONNREFUSED',
          message: 'connect ECONNREFUSED 127.0.0.1:5432',
        },
      },
    };
    const rejected = {
      ok: false as const,
      error: {
        category: 'rejected' as const,
        cause: {
          class: 'PostgresError',
          code: '28P01',
          message: 'password authentication failed',
        },
      },
    };
    const okFetch = { ok: true as const, value: undefined };
    const fastRecovery = { intervalMs: 5, delay: async () => {} };

    it('proceeds with normal startup after one unreachable inline attempt then ok', async () => {
      mockConfigReader.tryFetch
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValue(okFetch);

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        startupRetry: { delay: async () => {} },
        degradedRecovery: fastRecovery,
      });

      expect(result.ok).toBe(true);
      // Normal startup ran: the real control server bound, degraded closed.
      expect(mockServerStart).toHaveBeenCalled();
      expect(mockDegradedStart).toHaveBeenCalled();
      expect(mockDegradedClose).toHaveBeenCalled();
    });

    it('blocks in background retry then proceeds when recovery succeeds', async () => {
      // All inline attempts (default maxAttempts) fail unreachable, then the
      // first background poll succeeds.
      mockConfigReader.tryFetch
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValueOnce(unreachable)
        .mockResolvedValue(okFetch);

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        startupRetry: { maxAttempts: 5, delay: async () => {} },
        degradedRecovery: fastRecovery,
      });

      expect(result.ok).toBe(true);
      expect(mockServerStart).toHaveBeenCalled();
      expect(mockDegradedClose).toHaveBeenCalled();
    });

    it('fails loudly and cleans up on a rejected inline attempt', async () => {
      mockConfigReader.tryFetch.mockResolvedValue(rejected);

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json', {
        startupRetry: { delay: async () => {} },
        degradedRecovery: fastRecovery,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('startup config rejected');
        expect(result.error.message).toContain('28P01');
      }
      // Degraded server closed, DB client ended, real server never bound.
      expect(mockDegradedClose).toHaveBeenCalled();
      expect(mockDbSqlEnd).toHaveBeenCalled();
      expect(mockServerStart).not.toHaveBeenCalled();
    });

    it('returns the degraded start error and ends the DB client if the port is taken', async () => {
      mockDegradedStart.mockResolvedValueOnce(err(new Error('Instance lock failed')));

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Instance lock failed');
      }
      expect(mockDbSqlEnd).toHaveBeenCalled();
      expect(mockServerStart).not.toHaveBeenCalled();
    });
  });

  describe('runDegradedUntilRecovered', () => {
    const mkUnreachable = () => ({
      ok: false as const,
      error: {
        category: 'unreachable' as const,
        cause: {
          class: 'PostgresError',
          code: 'ECONNREFUSED',
          message: 'connect ECONNREFUSED 127.0.0.1:5432',
        },
      },
    });
    const mkRejected = () => ({
      ok: false as const,
      error: {
        category: 'rejected' as const,
        cause: {
          class: 'PostgresError',
          code: '42P01',
          message: 'relation does not exist',
        },
      },
    });
    const okFetch = { ok: true as const, value: undefined };

    it('keeps /health observable while unreachable, then resolves on recovery', async () => {
      const tryFetch = vi
        .fn()
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValue(okFetch);
      const reader = { tryFetch } as unknown as Parameters<
        typeof runDegradedUntilRecovered
      >[0];
      const degradedState = { lastConfigError: null as unknown };
      const handle = { close: vi.fn().mockResolvedValue(undefined) };
      const pg = { sql: { end: vi.fn().mockResolvedValue(undefined) } };

      const { runDegradedUntilRecovered } = await loadDaemon();

      await runDegradedUntilRecovered(
        reader,
        degradedState as never,
        handle,
        pg,
        { intervalMs: 1, delay: async () => {}, maxConsecutiveStuck: 3, webhooks: [] },
      );

      // The loop polled through both unreachable failures and then recovered
      // on the 3rd poll. During the outage degradedState.lastConfigError was
      // populated (this is what /health serves), proving observability while
      // degraded. The recovery resolved the await without closing the server.
      expect(tryFetch).toHaveBeenCalledTimes(3);
      expect(degradedState.lastConfigError).not.toBeNull();
      expect(handle.close).not.toHaveBeenCalled();
    });

    it('escalates once at maxConsecutiveStuck', async () => {
      const tryFetch = vi
        .fn()
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValueOnce(mkUnreachable())
        .mockResolvedValue(okFetch);
      const handle = { close: vi.fn().mockResolvedValue(undefined) };
      const pg = { sql: { end: vi.fn().mockResolvedValue(undefined) } };

      const { runDegradedUntilRecovered } = await loadDaemon();

      await runDegradedUntilRecovered(
        { tryFetch } as never,
        { lastConfigError: null } as never,
        handle,
        pg,
        {
          intervalMs: 1,
          delay: async () => {},
          maxConsecutiveStuck: 3,
          webhooks: ['hook'],
        },
      );

      // Notified exactly once (at the 3rd consecutive failure), not re-fired
      // on the 4th.
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(
        ['hook'],
        expect.objectContaining({ event: 'startup-degraded', phase: 'startup' }),
      );
    });

    it('exits on a background rejected outcome after cleanup', async () => {
      // Stub process.exit to throw a sentinel so the infinite loop terminates
      // deterministically once exit(1) is reached.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('__exit__');
      }) as never);
      const tryFetch = vi.fn().mockResolvedValue(mkRejected());
      const handle = { close: vi.fn().mockResolvedValue(undefined) };
      const pg = { sql: { end: vi.fn().mockResolvedValue(undefined) } };

      const { runDegradedUntilRecovered } = await loadDaemon();

      await expect(
        runDegradedUntilRecovered(
          { tryFetch } as never,
          { lastConfigError: null } as never,
          handle,
          pg,
          {
            intervalMs: 1,
            delay: async () => {},
            maxConsecutiveStuck: 3,
            webhooks: [],
          },
        ),
      ).rejects.toThrow('__exit__');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(handle.close).toHaveBeenCalled();
      expect(pg.sql.end).toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  describe('prompt contract validation at startup', () => {
    it('refuses to start when validatePromptContracts returns err', async () => {
      mockValidatePromptContracts.mockResolvedValueOnce(
        err(new Error('compliance-reviewer: template missing: [issueTitle]')),
      );
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/template missing.*issueTitle/);
      }
      // Other startup work should NOT have proceeded:
      expect(mockStateMgr.initialize).not.toHaveBeenCalled();
    });

    it('proceeds with startup when validation passes', async () => {
      mockValidatePromptContracts.mockResolvedValueOnce(ok({ checked: 3 }));
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
    });
  });

  describe('runtime source preflight (#489)', () => {
    it('fails startup when runtime source policy requests fail on unhealthy source', async () => {
      mockValidateRuntimeSource.mockResolvedValueOnce({
        enabled: true,
        healthy: false,
        sourceRoot: '/repo',
        expectedRef: 'origin/staging',
        clean: false,
        dirtyPaths: ['packages/daemon/src/control-plane/daemon.ts'],
        synchronized: 'unknown',
        checkedAt: '2026-05-14T00:00:00.000Z',
        action: 'fail',
        failureKind: 'dirty-runtime-source',
        message: 'Runtime source has uncommitted changes',
      });

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(
          'Runtime source preflight failed',
        );
      }
      expect(mockStateMgr.initialize).not.toHaveBeenCalled();
    });

    it('starts paused and skips crash resumption when runtime source policy pauses', async () => {
      mockValidateRuntimeSource.mockResolvedValueOnce({
        enabled: true,
        healthy: false,
        sourceRoot: '/repo',
        expectedRef: 'origin/staging',
        clean: false,
        dirtyPaths: ['packages/daemon/src/control-plane/daemon.ts'],
        synchronized: false,
        checkedAt: '2026-05-14T00:00:00.000Z',
        action: 'pause',
        failureKind: 'dirty-runtime-source',
        message: 'Runtime source has uncommitted changes',
      });

      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
      expect(mockStateMgr.findIncompleteRuns).not.toHaveBeenCalled();
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;
      expect(status['paused']).toBe(true);
      expect(status['runtimeSource']).toMatchObject({
        healthy: false,
        failureKind: 'dirty-runtime-source',
        action: 'pause',
      });
    });

    it('rejects resume when runtime source revalidation is unhealthy', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');
      const result = await startDaemon('config.json');
      expect(result.ok).toBe(true);

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      handlers.pause();
      mockValidateRuntimeSource.mockResolvedValueOnce({
        enabled: true,
        healthy: false,
        sourceRoot: '/repo',
        expectedRef: 'origin/staging',
        clean: false,
        dirtyPaths: ['packages/daemon/src/control-plane/daemon.ts'],
        synchronized: false,
        checkedAt: '2026-05-14T00:01:00.000Z',
        action: 'pause',
        failureKind: 'dirty-runtime-source',
        message: 'Runtime source has uncommitted changes',
      });

      const resumeResult = await handlers.resume();

      expect(resumeResult).toMatchObject({ ok: false });
      const status = handlers.getStatus() as Record<string, unknown>;
      expect(status['paused']).toBe(true);
      expect(status['runtimeSource']).toMatchObject({
        healthy: false,
        failureKind: 'dirty-runtime-source',
      });
    });
  });

  describe('interactive PO session launch guard (atomic in-process)', () => {
    it('rejects a second concurrent launch with 409 while the first is mid-assembly (before its fs marker)', async () => {
      // No active fs marker yet — proves the 409 comes from the synchronous
      // in-process guard, not the fs check (which is written only post-assembly).
      mockHasActiveInteractiveSession.mockResolvedValue(false);

      // Park the first launch mid-assembly: startInteractivePOSession stays pending
      // (its session-record marker is never written) while the second request races.
      let resolveLaunch!: (value: unknown) => void;
      mockStartInteractivePOSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
      );

      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');
      const result = await startDaemon('config.json');
      expect(result.ok).toBe(true);

      const handlers = vi.mocked(createControlServer).mock.lastCall![1] as {
        startInteractivePoSession: () => Promise<{
          status: number;
          body: unknown;
        }>;
      };

      // First launch: runs synchronously up to its first await (the in-process flag
      // is already set true), then parks inside the pending startInteractivePOSession.
      const first = handlers.startInteractivePoSession();
      // Let the first call progress past the synchronous guard + fs check.
      await Promise.resolve();
      await Promise.resolve();

      // Second concurrent launch must be rejected by the in-process guard.
      const second = await handlers.startInteractivePoSession();
      expect(second.status).toBe(409);

      // The second request short-circuited BEFORE the fs check and before any
      // second launch was started.
      expect(mockStartInteractivePOSession).toHaveBeenCalledTimes(1);
      expect(mockHasActiveInteractiveSession).toHaveBeenCalledTimes(1);

      // Resolve the first launch; it completes 200 and the finally clears the guard.
      resolveLaunch({
        ok: true,
        value: {
          id: 'po-session-1',
          endReason: 'explicit_close',
          needsDiscussionResolved: 0,
          summary: '',
        },
      });
      const firstResult = await first;
      expect(firstResult.status).toBe(200);

      // Guard cleared — a fresh, non-concurrent launch proceeds normally.
      const third = await handlers.startInteractivePoSession();
      expect(third.status).toBe(200);
      expect(mockStartInteractivePOSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('crash resumption (#89)', () => {
    it('calls findIncompleteRuns on startup', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockStateMgr.findIncompleteRuns).toHaveBeenCalled();
    });

    it('resumes incomplete runs through the pipeline', async () => {
      const incompleteRun = {
        id: 'run-abc',
        issueNumber: 55,
        title: 'Incomplete feature',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: { detect: true, classify: true },
        checkpoints: [],
        cost: 2,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPipeline).toHaveBeenCalled();
      const callArgs = mockRunPipeline.mock.calls[0]!;
      expect(callArgs[0]).toMatchObject({
        issueNumber: 55,
        phase: 'implement',
      });
    });

    it('falls back to config.repo when run has no repoOwner/repoName', async () => {
      const incompleteRun = {
        id: 'run-xyz',
        issueNumber: 66,
        title: 'Old run',
        phase: 'review',
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunPipeline).toHaveBeenCalled();
      const callArgs = mockRunPipeline.mock.calls[0]!;
      expect(callArgs[0]).toMatchObject({ issueNumber: 66 });
    });

    it('uses persisted body/labels/specRefs from RunState on crash resume (#108)', async () => {
      const incompleteRun = {
        id: 'run-108',
        issueNumber: 108,
        title: 'Feature with spec refs',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: { detect: true },
        checkpoints: [],
        cost: 1,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        body: 'Original issue body with details',
        labels: ['ready', 'enhancement'],
        specRefs: ['FUNC-AC-PIPELINE', 'ARCH-AC-CONTROL-PLANE'],
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      const workRequest = phaseHandlerCalls[0]![6] as WorkRequest;
      expect(workRequest.body).toBe('Original issue body with details');
      expect(workRequest.labels).toEqual(['ready', 'enhancement']);
      expect(workRequest.specRefs).toEqual([
        'FUNC-AC-PIPELINE',
        'ARCH-AC-CONTROL-PLANE',
      ]);
    });

    it('falls back to empty defaults when RunState lacks body/labels/specRefs (#108)', async () => {
      const incompleteRun = {
        id: 'run-legacy',
        issueNumber: 55,
        title: 'Legacy run without body',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      const workRequest = phaseHandlerCalls[0]![6] as WorkRequest;
      expect(workRequest.body).toBe('');
      expect(workRequest.labels).toEqual([]);
      expect(workRequest.specRefs).toEqual([]);
    });

    it('decrements activeRuns after resumed run completes', async () => {
      const config = makeConfig({ maxConcurrentRuns: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));

      let resolveResume!: (v: { outcome: string }) => void;
      mockRunPipeline.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveResume = r;
          }),
      );

      const incompleteRun = {
        id: 'run-block',
        issueNumber: 77,
        title: 'Blocking run',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // Resumed run is blocking — new work should be skipped
      const request = makeWorkRequest({ issueNumber: 99 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.claimWork).not.toHaveBeenCalled();

      // Resolve the resumed run
      resolveResume({ outcome: 'complete' });
      await vi.advanceTimersByTimeAsync(0);

      // Now new work should be claimable
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(99);
    });

    it('auto-pauses after maxConsecutiveStuck crash-resumed stuck runs (#291)', async () => {
      const config = makeConfig({
        maxConsecutiveStuck: 2,
        webhooks: ['https://hooks.example.com/test'],
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      // Two incomplete runs that will both finish stuck
      const run1 = {
        id: 'run-stuck-1',
        issueNumber: 80,
        title: 'Stuck resumed run 1',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      const run2 = {
        ...run1,
        id: 'run-stuck-2',
        issueNumber: 81,
        title: 'Stuck resumed run 2',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([run1, run2]);
      mockRunPipeline.mockResolvedValue({
        outcome: 'stuck',
        error: 'test failure',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        true,
      );
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(2);
      expect(mockNotify).toHaveBeenCalledWith(
        ['https://hooks.example.com/test'],
        expect.objectContaining({
          event: 'auto-paused',
          message: expect.stringContaining('2 consecutive stuck runs'),
        }),
      );
    });

    it('resets consecutive stuck count when crash-resumed run completes successfully (#291)', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 3 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const incompleteRun = {
        id: 'run-success',
        issueNumber: 82,
        title: 'Successful resumed run',
        phase: 'implement',
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([incompleteRun]);
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First, cause a stuck run via polling to set consecutiveStuckCount to 1
      mockRunPipeline.mockResolvedValue({ outcome: 'stuck', error: 'fail' });
      const request = makeWorkRequest({ issueNumber: 90 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request]));
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      // The crash-resumed run completed first (resetting count to 0), then poll run stuck (count = 1)
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(1);
    });
  });

  describe('legacy polling loop', () => {
    it('polls for work at configured interval', async () => {
      const config = makeConfig({ pollIntervalMs: 5000 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // No work detected yet
      expect(mockDetector.detectReadyWork).not.toHaveBeenCalled();

      // Advance timer by one poll interval
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockDetector.detectReadyWork).toHaveBeenCalledTimes(1);
    });

    it('skips polling when paused', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      // Extract pause handler from createControlServer call and invoke it
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      handlers.pause();

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectReadyWork).not.toHaveBeenCalled();
    });

    it('pauses before polling when runtime source becomes unhealthy', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');
      await startDaemon('config.json');

      mockValidateRuntimeSource.mockResolvedValueOnce({
        enabled: true,
        healthy: false,
        sourceRoot: '/repo',
        expectedRef: 'origin/staging',
        clean: false,
        dirtyPaths: ['packages/daemon/src/control-plane/daemon.ts'],
        synchronized: false,
        checkedAt: '2026-05-14T00:02:00.000Z',
        action: 'pause',
        failureKind: 'dirty-runtime-source',
        message: 'Runtime source has uncommitted changes',
      });

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectReadyWork).not.toHaveBeenCalled();
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;
      expect(status['paused']).toBe(true);
      expect(status['runtimeSource']).toMatchObject({
        healthy: false,
        failureKind: 'dirty-runtime-source',
      });
    });

    it('claims and processes work when detected', async () => {
      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimWork).toHaveBeenCalledWith(42);
      expect(mockClassifyBatch).toHaveBeenCalledTimes(1);
      // Flush microtask queue so processWorkRequest's .then/.catch/.finally resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStateMgr.saveRunState).toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    it('classifies multiple ready issues in one batch before pipeline start (#470)', async () => {
      const config = makeConfig({
        maxConcurrentRuns: 3,
        classifierBatchSize: 2,
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const requests = [
        makeWorkRequest({ issueNumber: 1 }),
        makeWorkRequest({ issueNumber: 2 }),
        makeWorkRequest({ issueNumber: 3 }),
      ];
      mockDetector.detectReadyWork.mockResolvedValue(ok(requests));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 1,
            classified: true,
            event: 'success:simple',
            complexity: 'simple',
            allocatedCost: 0.05,
          },
          {
            issueNumber: 2,
            classified: true,
            event: 'success',
            complexity: 'complex',
            allocatedCost: 0.05,
          },
        ],
        totalCost: 0.1,
        batchSequenceId: 'batch-1',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimWork).toHaveBeenCalledWith(1);
      // gap #6: same-repo detect is serialized at the claim GATE (checked before
      // claimWork, so a gated issue is never stranded as in-progress). Issues
      // 1/2/3 share the daemon's single repo, so only #1 is claimed this tick; #2
      // and #3 are gated and re-detected next poll once #1's detect settles and
      // releases the repo gate. Because classification runs on CLAIMED work
      // (preClassifyReadyWork, after the gate), only #1 is classified + started.
      // Same-repo detects can never truly run concurrently (the git-worktree lock
      // enforces this) — gap #6 serializes cleanly instead of contending.
      // NOTE: this serializes same-repo batch classification to 1/tick; a future
      // optimization could classify pre-gate to restore batching via gap#5's cache.
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(2);
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(3);
      expect(mockClassifyBatch).toHaveBeenCalledTimes(1);
      expect(mockClassifyBatch.mock.calls[0]?.[1]).toEqual([
        expect.objectContaining({ issueNumber: 1 }),
      ]);
      const startedRequests = phaseHandlerCalls.map(
        (call) => call[6] as WorkRequest,
      );
      expect(startedRequests).toEqual([
        expect.objectContaining({
          issueNumber: 1,
          preClassification: expect.objectContaining({
            complexity: 'simple',
            allocatedCost: 0.05,
          }),
        }),
      ]);
    });

    it('skips claiming when at max concurrency', async () => {
      const config = makeConfig({ maxConcurrentRuns: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // Make processWorkRequest block so activeRuns stays incremented
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // never resolves

      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First poll: claims work, activeRuns becomes 1
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.claimWork).toHaveBeenCalledTimes(1);

      // Second poll: should skip because activeRuns >= maxConcurrentRuns
      mockDetector.claimWork.mockClear();
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.claimWork).not.toHaveBeenCalled();
    });

    it('continues polling when work detection returns error', async () => {
      mockDetector.detectReadyWork.mockResolvedValue(
        err(new Error('API rate limited')),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.claimWork).not.toHaveBeenCalled();

      // Should not throw — next poll tick should still fire
      mockDetector.detectReadyWork.mockResolvedValue(ok([]));
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.detectReadyWork).toHaveBeenCalledTimes(2);
    });

    it('does not start an overlapping poll tick while work detection is still running', async () => {
      const config = makeConfig({
        pollIntervalMs: 1000,
        maxConcurrentRuns: 10,
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      let resolveDetect!: (
        value: Awaited<ReturnType<typeof mockDetector.detectReadyWork>>,
      ) => void;
      const pendingDetect = new Promise<
        Awaited<ReturnType<typeof mockDetector.detectReadyWork>>
      >((resolve) => {
        resolveDetect = resolve;
      });
      mockDetector.detectReadyWork.mockReturnValueOnce(pendingDetect);

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDetector.detectReadyWork).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDetector.detectReadyWork).toHaveBeenCalledTimes(1);

      resolveDetect(ok([]));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockDetector.detectReadyWork).toHaveBeenCalledTimes(2);
    });

    it('skips work item when claim fails', async () => {
      const requests = [
        makeWorkRequest({ issueNumber: 1 }),
        makeWorkRequest({ issueNumber: 2 }),
      ];
      mockDetector.detectReadyWork.mockResolvedValue(ok(requests));
      mockDetector.claimWork
        .mockResolvedValueOnce(err(new Error('already claimed')))
        .mockResolvedValueOnce(ok(undefined));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimWork).toHaveBeenCalledWith(1);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(2);
    });

    it('resets daily cost tracker each poll tick', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockCostTracker.maybeResetDaily).toHaveBeenCalled();
    });
  });

  // --- gap #5 tests: preClassifyReadyWork caches only real classifications ---
  describe('preClassifyReadyWork', () => {
    it('preClassif: sets preClassification with full cached fields when classified:true and complexity is present', async () => {
      const request = makeWorkRequest({ issueNumber: 10 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 10,
            classified: true,
            event: 'success:simple',
            complexity: 'standard',
            changeKind: 'feature',
            scope: 'backend',
            allocatedCost: 0.05,
          },
        ],
        totalCost: 0.05,
        batchSequenceId: 'batch-gate-1',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const workRequests = phaseHandlerCalls.map((call) => call[6] as { preClassification?: unknown });
      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      expect(workRequests[0]).toEqual(
        expect.objectContaining({
          preClassification: {
            event: 'success:simple',
            complexity: 'standard',
            changeKind: 'feature',
            scope: 'backend',
            allocatedCost: 0.05,
            batchSequenceId: 'batch-gate-1',
          },
        }),
      );
    });

    it('preClassif: does NOT cache preClassification when classified:false (rate-limited)', async () => {
      const request = makeWorkRequest({ issueNumber: 11 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 11,
            classified: false,
            event: 'rate-limited',
            allocatedCost: 0,
          },
        ],
        totalCost: 0,
        batchSequenceId: 'batch-gate-2',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const workRequests = phaseHandlerCalls.map((call) => call[6] as WorkRequest);
      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      expect((workRequests[0] as WorkRequest).issueNumber).toBe(11);
      expect(workRequests[0]).not.toHaveProperty('preClassification');
    });

    it('preClassif: does NOT cache preClassification when classified:false even if complexity is present', async () => {
      // classified:false is authoritative — complexity alone does not make it a real classification
      const request = makeWorkRequest({ issueNumber: 14 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 14,
            classified: false,
            event: 'rate-limited',
            complexity: 'standard', // has complexity but classified:false → should NOT cache
            allocatedCost: 0,
          },
        ],
        totalCost: 0,
        batchSequenceId: 'batch-gate-5',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const workRequests = phaseHandlerCalls.map((call) => call[6] as WorkRequest);
      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      expect((workRequests[0] as WorkRequest).issueNumber).toBe(14);
      expect(workRequests[0]).not.toHaveProperty('preClassification');
    });

    it('preClassif: does NOT cache preClassification when classified:false event:success:simple (orderResults empty fallback)', async () => {
      const request = makeWorkRequest({ issueNumber: 12 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 12,
            classified: false,
            event: 'success:simple',
            allocatedCost: 0,
          },
        ],
        totalCost: 0,
        batchSequenceId: 'batch-gate-3',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const workRequests = phaseHandlerCalls.map((call) => call[6] as WorkRequest);
      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      expect((workRequests[0] as WorkRequest).issueNumber).toBe(12);
      expect(workRequests[0]).not.toHaveProperty('preClassification');
    });

    it('preClassif: does NOT cache preClassification when classified:true but complexity:undefined (classifier session-failed fallback)', async () => {
      // This is the codex-critical case: classified:true alone is NOT the unambiguous signal.
      // When the classifier session fails and falls back to success:simple, complexity is undefined.
      const request = makeWorkRequest({ issueNumber: 13 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockClassifyBatch.mockResolvedValueOnce({
        results: [
          {
            issueNumber: 13,
            classified: true,
            event: 'success:simple',
            complexity: undefined,
            allocatedCost: 0,
          },
        ],
        totalCost: 0,
        batchSequenceId: 'batch-gate-4',
        status: 'complete',
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const workRequests = phaseHandlerCalls.map((call) => call[6] as WorkRequest);
      expect(phaseHandlerCalls.length).toBeGreaterThan(0);
      expect((workRequests[0] as WorkRequest).issueNumber).toBe(13);
      expect(workRequests[0]).not.toHaveProperty('preClassification');
    });
  });

  describe('processWorkRequest (via polling)', () => {
    it('creates RunState with correct fields from work request', async () => {
      const request = makeWorkRequest({ issueNumber: 99, title: 'My feature' });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 99,
          title: 'My feature',
          variant: 'feature',
          phase: 'detect',
          cost: 0,
          fixAttempts: [],
          errorHashes: {},
          phaseCompletions: {},
          checkpoints: [],
        }),
      );
    });

    it('persists body/labels/specRefs in RunState (#108)', async () => {
      const request = makeWorkRequest({
        issueNumber: 108,
        title: 'Feature',
        body: 'Detailed body text',
        labels: ['ready', 'feature'],
        specRefs: ['FUNC-AC-PIPELINE'],
      });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Detailed body text',
          labels: ['ready', 'feature'],
          specRefs: ['FUNC-AC-PIPELINE'],
        }),
      );
    });

    it('marks stuck and notifies on stuck outcome', async () => {
      mockRunPipeline.mockResolvedValue({
        outcome: 'stuck',
        error: 'budget exceeded',
      });

      const request = makeWorkRequest({ issueNumber: 7 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const config = makeConfig({
        webhooks: ['https://hooks.example.com/test'],
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.markStuck).toHaveBeenCalledWith(7, 'budget exceeded');
      expect(mockNotify).toHaveBeenCalledWith(
        ['https://hooks.example.com/test'],
        expect.objectContaining({
          event: 'stuck',
          issueNumber: 7,
        }),
      );
    });

    it('does not mark stuck on complete outcome', async () => {
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.markStuck).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('decrements activeRuns after processWorkRequest completes', async () => {
      const config = makeConfig({ maxConcurrentRuns: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const request = makeWorkRequest();
      // First poll: return work, then complete immediately
      mockDetector.detectReadyWork
        .mockResolvedValueOnce(ok([request]))
        .mockResolvedValueOnce(ok([makeWorkRequest({ issueNumber: 2 })]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First poll claims and processes
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Second poll should be able to claim again (activeRuns decremented)
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimWork).toHaveBeenCalledTimes(2);
    });

    it('catches and logs processWorkRequest errors without crashing', async () => {
      mockRunPipeline.mockRejectedValue(new Error('unexpected failure'));

      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('#42'),
        expect.any(Error),
      );
    });
  });

  describe('consecutive stuck auto-pause (#90)', () => {
    it('auto-pauses after maxConsecutiveStuck stuck runs and notifies', async () => {
      const config = makeConfig({
        maxConsecutiveStuck: 2,
        webhooks: ['https://hooks.example.com/test'],
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      mockRunPipeline.mockResolvedValue({
        outcome: 'stuck',
        error: 'test failure',
      });

      const request1 = makeWorkRequest({ issueNumber: 1 });
      const request2 = makeWorkRequest({ issueNumber: 2 });

      // First poll: one stuck run
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // After first stuck: not yet paused
      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        false,
      );

      // Second poll: another stuck run → auto-pause
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        true,
      );
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(2);
      expect(mockNotify).toHaveBeenCalledWith(
        ['https://hooks.example.com/test'],
        expect.objectContaining({
          event: 'auto-paused',
          message: expect.stringContaining('2 consecutive stuck runs'),
        }),
      );
    });

    it('resets consecutive stuck count on successful completion', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 3 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({
        outcome: 'stuck',
        error: 'fail',
      });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(1);

      // Second run: complete → resets count
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'complete' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(0);
    });

    it('resets stuck count and pauses daemon on paused outcome (#109, #293)', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 3 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({
        outcome: 'stuck',
        error: 'fail',
      });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(1);

      // Second run: paused (budget exceeded) → resets count AND pauses daemon
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'paused' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(0);
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        true,
      );

      // Daemon is paused — no new work will be processed, so stuck count stays 0
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(0);
    });

    it('auto-pauses daemon on budget-exceeded paused outcome (#293)', async () => {
      const config = makeConfig({
        webhooks: ['https://hooks.example.com/test'],
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      mockRunPipeline.mockResolvedValueOnce({ outcome: 'paused' });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        true,
      );
      expect(mockNotify).toHaveBeenCalledWith(
        ['https://hooks.example.com/test'],
        expect.objectContaining({
          event: 'auto-paused',
          message: expect.stringContaining('daily budget exceeded'),
        }),
      );
    });

    it('exposes consecutiveStuckCount in status endpoint', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;

      expect(status).toHaveProperty('consecutiveStuckCount', 0);
    });
  });

  describe('graceful shutdown', () => {
    it('prevents new work from being claimed after shutdown', async () => {
      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // Trigger shutdown
      await signalHandlers['SIGTERM']!();

      // Advance past poll interval
      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimWork).not.toHaveBeenCalled();
    });

    it('closes control server and stops remote control on shutdown', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await signalHandlers['SIGTERM']!();

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockRemoteControl.stop).toHaveBeenCalled();
    });

    it('is idempotent — second shutdown call is a no-op', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await signalHandlers['SIGTERM']!();
      mockServer.close.mockClear();
      mockRemoteControl.stop.mockClear();

      await signalHandlers['SIGTERM']!();

      expect(mockServer.close).not.toHaveBeenCalled();
      expect(mockRemoteControl.stop).not.toHaveBeenCalled();
    });
  });

  describe('control server handlers', () => {
    it('provides status handler with correct shape', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;

      expect(status).toEqual(
        expect.objectContaining({
          activeRuns: 0,
          dailyCost: 0,
          paused: false,
        }),
      );
      expect(status['uptime']).toBeDefined();
    });

    it('strips remote_control_url from status response (#154)', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      // Mock getState to return all fields including the sensitive URL
      mockRemoteControl.getState.mockReturnValue({
        remote_control_state: 'active',
        remote_control_url: 'https://claude.ai/remote/secret',
        remote_control_error: null,
      });

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;

      // remote_control_state and remote_control_error are safe to expose
      expect(status).toHaveProperty('remote_control_state', 'active');
      expect(status).toHaveProperty('remote_control_error', null);
      // remote_control_url could enable session takeover — must not be exposed
      expect(status).not.toHaveProperty('remote_control_url');
    });

    it('pause/resume toggles paused state visible in status', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        false,
      );
      handlers.pause();
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        true,
      );
      await handlers.resume();
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        false,
      );
    });

    it('exposes dailyRunCount: 0 in status before any runs', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const status = handlers.getStatus() as Record<string, unknown>;

      expect(status).toHaveProperty('dailyRunCount', 0);
    });

    it('increments dailyRunCount each time a run is processed', async () => {
      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];

      expect(
        (handlers.getStatus() as Record<string, unknown>)['dailyRunCount'],
      ).toBe(0);

      // Trigger a poll so one run is processed
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        (handlers.getStatus() as Record<string, unknown>)['dailyRunCount'],
      ).toBe(1);
    });
  });

  describe('bug-fix pipeline routing (#284)', () => {
    it('polls detectBugFixWork after ready work processing', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectBugFixWork).toHaveBeenCalledTimes(1);
    });

    it('claims and processes bug-fix work when detected', async () => {
      const bugRequest = makeWorkRequest({
        issueNumber: 50,
        title: 'Fix null check',
        labels: ['review-finding', 'P1'],
        workType: 'bug-fix',
      });
      mockDetector.detectBugFixWork.mockResolvedValue(ok(bugRequest));
      mockSelectVariant.mockReturnValue('bug');

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimBugFixWork).toHaveBeenCalledWith(50);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    it('uses bug variant for bug-fix work requests', async () => {
      const bugRequest = makeWorkRequest({
        issueNumber: 50,
        title: 'Fix null check',
        labels: ['review-finding', 'P1'],
        workType: 'bug-fix',
      });
      mockDetector.detectBugFixWork.mockResolvedValue(ok(bugRequest));
      mockSelectVariant.mockReturnValue('bug');

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 50,
          variant: 'bug',
        }),
      );
    });

    it('skips bug-fix detection when at max concurrency from ready work', async () => {
      const config = makeConfig({ maxConcurrentRuns: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // Ready work fills concurrency
      const readyRequest = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([readyRequest]));
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // never resolves

      const bugRequest = makeWorkRequest({
        issueNumber: 50,
        labels: ['review-finding', 'P1'],
        workType: 'bug-fix',
      });
      mockDetector.detectBugFixWork.mockResolvedValue(ok(bugRequest));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      // Ready work claimed, but bug-fix should be skipped due to concurrency
      expect(mockDetector.claimWork).toHaveBeenCalledWith(1);
      expect(mockDetector.claimBugFixWork).not.toHaveBeenCalled();
    });

    it('skips bug-fix when claim fails', async () => {
      const bugRequest = makeWorkRequest({
        issueNumber: 50,
        labels: ['review-finding', 'P1'],
        workType: 'bug-fix',
      });
      mockDetector.detectBugFixWork.mockResolvedValue(ok(bugRequest));
      mockDetector.claimBugFixWork.mockResolvedValue(
        err(new Error('already claimed')),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimBugFixWork).toHaveBeenCalledWith(50);
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('handles detectBugFixWork returning an error gracefully', async () => {
      mockDetector.detectBugFixWork.mockResolvedValue(
        err(new Error('API error')),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.detectBugFixWork).toHaveBeenCalled();
      expect(mockDetector.claimBugFixWork).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('does not call detectBugFixWork when paused', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      handlers.pause();

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectBugFixWork).not.toHaveBeenCalled();
    });
  });

  describe('feature-pipeline routing (#282)', () => {
    it('polls detectFeaturePipelineWork after bug-fix processing', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectFeaturePipelineWork).toHaveBeenCalledTimes(1);
    });

    it('claims and processes feature-pipeline work when detected', async () => {
      const fpRequest = makeWorkRequest({
        issueNumber: 60,
        title: 'Brainstorm L2 spec',
        labels: ['feature-pipeline', 'l1-approved'],
        workType: 'l2-brainstorm',
      });
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(fpRequest));
      mockSelectVariant.mockReturnValue('spec-driven');

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimFeaturePipelineWork).toHaveBeenCalledWith(
        60,
        'l2-brainstorm',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    it('routes feature-pipeline work to spec-driven variant via selectVariant', async () => {
      const fpRequest = makeWorkRequest({
        issueNumber: 61,
        title: 'Generate L3',
        labels: ['feature-pipeline', 'l2-approved'],
        workType: 'l3-generate',
      });
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(fpRequest));
      mockSelectVariant.mockReturnValue('spec-driven');

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 61,
          variant: 'spec-driven',
        }),
      );
    });

    it('skips feature-pipeline detection when at max concurrency', async () => {
      const config = makeConfig({ maxConcurrentRuns: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // Ready work fills concurrency
      const readyRequest = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([readyRequest]));
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // never resolves

      const fpRequest = makeWorkRequest({
        issueNumber: 60,
        labels: ['feature-pipeline', 'l1-approved'],
        workType: 'l2-brainstorm',
      });
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(fpRequest));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimWork).toHaveBeenCalledWith(1);
      expect(mockDetector.claimFeaturePipelineWork).not.toHaveBeenCalled();
    });

    it('skips feature-pipeline when claim fails', async () => {
      const fpRequest = makeWorkRequest({
        issueNumber: 60,
        labels: ['feature-pipeline', 'l1-approved'],
        workType: 'l2-brainstorm',
      });
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(fpRequest));
      mockDetector.claimFeaturePipelineWork.mockResolvedValue(
        err(new Error('already claimed')),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimFeaturePipelineWork).toHaveBeenCalledWith(
        60,
        'l2-brainstorm',
      );
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('handles detectFeaturePipelineWork returning an error gracefully', async () => {
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(
        err(new Error('API error')),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.detectFeaturePipelineWork).toHaveBeenCalled();
      expect(mockDetector.claimFeaturePipelineWork).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('does not call detectFeaturePipelineWork when paused', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      handlers.pause();

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.detectFeaturePipelineWork).not.toHaveBeenCalled();
    });

    it('deduplicates: skips feature-pipeline work if same issue already claimed by ready work', async () => {
      // Ready work detects issue #60
      const readyRequest = makeWorkRequest({ issueNumber: 60 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([readyRequest]));

      // Feature pipeline also detects issue #60
      const fpRequest = makeWorkRequest({
        issueNumber: 60,
        labels: ['feature-pipeline', 'l1-approved'],
        workType: 'l2-brainstorm',
      });
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(ok(fpRequest));

      const config = makeConfig({ maxConcurrentRuns: 5 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Ready work was claimed
      expect(mockDetector.claimWork).toHaveBeenCalledWith(60);
      // Feature pipeline should NOT try to claim the same issue
      expect(mockDetector.claimFeaturePipelineWork).not.toHaveBeenCalled();
    });
  });

  describe('PO agent wiring (#343)', () => {
    it('creates PO agent with config intervals on startup', async () => {
      const config = makeConfig({
        coordination: {
          ...makeConfig().coordination,
          poInterval: 1800000,
          poIdeaDebounce: 300000,
        },
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockCreatePOAgent).toHaveBeenCalledTimes(1);
      const [, poConfig] = mockCreatePOAgent.mock.calls[0]!;
      expect((poConfig as { intervalMs: number }).intervalMs).toBe(1800000);
      expect((poConfig as { debounceMs: number }).debounceMs).toBe(300000);
    });

    it('starts PO agent and calls start()', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const agent = mockCreatePOAgent.mock.results[0]!.value;
      expect(agent.start).toHaveBeenCalledTimes(1);
    });

    it('stops PO agent on shutdown', async () => {
      const mockStopPO = vi.fn();
      mockCreatePOAgent.mockReturnValue({
        start: vi.fn().mockReturnValue(mockStopPO),
        submitIdea: vi.fn(),
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // SIGTERM enters drain mode (stops schedulers) then calls shutdown (stops again — idempotent)
      await signalHandlers['SIGTERM']!();

      expect(mockStopPO).toHaveBeenCalled();
    });

    it('passes submitIdea handler to control server', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect(handlers.submitIdea).toBeDefined();
    });

    it('submitIdea handler delegates to PO agent', async () => {
      const { startDaemon } = await loadDaemon();
      const { createControlServer } = await import('./server.js');

      await startDaemon('config.json');

      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      const result = await handlers.submitIdea!('operator', 'Build dark mode');

      const agent = mockCreatePOAgent.mock.results[0]!.value;
      expect(agent.submitIdea).toHaveBeenCalledWith(
        'operator',
        'Build dark mode',
      );
      expect(result.id).toBe('idea-1');
    });
  });

  describe('review scheduler config (#334)', () => {
    it('passes coordination.reviewerInterval to createReviewScheduler (#356)', async () => {
      const config = makeConfig({
        coordination: {
          ...makeConfig().coordination,
          reviewerInterval: 7200000, // 2 hours — non-default
        },
        validation: {
          ...makeConfig().validation,
          proactiveThrottleThreshold: 0.75, // non-default
        },
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockCreateReviewScheduler).toHaveBeenCalledTimes(1);
      const [, schedulerConfig] = mockCreateReviewScheduler.mock.calls[0]!;
      expect(schedulerConfig.intervalMs).toBe(7200000);
      expect(schedulerConfig.signalRatioThreshold).toBe(0.75);
    });

    it('does NOT use validation.proactiveIntervalMs for review scheduler interval (#356)', async () => {
      const config = makeConfig({
        coordination: {
          ...makeConfig().coordination,
          reviewerInterval: 5400000, // 90 minutes
        },
        validation: {
          ...makeConfig().validation,
          proactiveIntervalMs: 900000, // 15 minutes — must be ignored
        },
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const [, schedulerConfig] = mockCreateReviewScheduler.mock.calls[0]!;
      // Must use coordination.reviewerInterval, not validation.proactiveIntervalMs
      expect(schedulerConfig.intervalMs).toBe(5400000);
      expect(schedulerConfig.intervalMs).not.toBe(900000);
    });
  });

  describe('review scheduler structuredData mapping (#462)', () => {
    it('maps codebase-reviewer findings[] to findingsCount (not findingsCount field)', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // Capture the deps passed to createReviewScheduler
      const [deps] = mockCreateReviewScheduler.mock.calls[0]!;

      // Mock spawnSession to return codebase-reviewer output format
      mockSpawnSession.mockResolvedValueOnce(
        ok({
          output: 'review output',
          structuredData: {
            category: 'correctness',
            findings: [
              {
                title: 'Bug A',
                severity: 'important',
                location: 'foo.ts:1',
                description: 'd',
                evidence: 'e',
              },
              {
                title: 'Bug B',
                severity: 'critical',
                location: 'bar.ts:2',
                description: 'd',
                evidence: 'e',
              },
            ],
            scannedFiles: 15,
            candidatesFound: 8,
            candidatesDropped: 6,
            summary: 'Found 2 verified issues',
          },
          cost: 0.05,
          pitfallMarkers: [],
          exitStatus: 'success',
        }),
      );

      const result = await deps.spawnReviewSession('correctness', 5);
      expect(result.findingsCount).toBe(2);
      expect(result.issuesCreated).toBe(0);
    });

    it('returns findingsCount 0 when structuredData has no findings array', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const [deps] = mockCreateReviewScheduler.mock.calls[0]!;

      mockSpawnSession.mockResolvedValueOnce(
        ok({
          output: 'review output',
          structuredData: null,
          cost: 0.01,
          pitfallMarkers: [],
          exitStatus: 'success',
        }),
      );

      const result = await deps.spawnReviewSession('security', 5);
      expect(result.findingsCount).toBe(0);
      expect(result.issuesCreated).toBe(0);
    });
  });

  describe('review scheduler workspace scoping (#692)', () => {
    it('scopes the codebase-reviewer session to the repo root via workspacePath (not an empty temp dir)', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const [deps] = mockCreateReviewScheduler.mock.calls[0]!;

      mockSpawnSession.mockResolvedValueOnce(
        ok({
          output: 'review output',
          structuredData: null,
          cost: 0.01,
          pitfallMarkers: [],
          exitStatus: 'success',
        }),
      );

      await deps.spawnReviewSession('security', 5);

      // Without workspacePath the CLI adapter falls back to an empty temp dir
      // (the SEC-34 containment path in cli.ts), leaving the reviewer with no
      // codebase to review. It must be scoped to the repo root.
      expect(mockSpawnSession).toHaveBeenCalledWith(
        'codebase-reviewer',
        expect.objectContaining({ workspacePath: process.cwd() }),
        0,
      );
    });
  });

  describe('coordinator wiring (#345)', () => {
    it('does not instantiate coordinator when useCoordinator is false (default)', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      expect(mockCreateCoordinator).not.toHaveBeenCalled();
    });

    it('instantiates coordinator when useCoordinator is true', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      expect(mockCreateCoordinator).toHaveBeenCalledTimes(1);
    });

    it('passes CoordinatorConfig with correct values from config', async () => {
      const config = makeConfig({
        coordination: {
          ...makeConfig().coordination,
          useCoordinator: true,
          tickInterval: 3000,
          maxAgents: 5,
          diskSpaceThreshold: 1_000_000_000,
        },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      const [, coordConfig] = mockCreateCoordinator.mock.calls[0]!;
      expect(coordConfig).toMatchObject({
        tickIntervalMs: 3000,
        maxAgents: 5,
        diskSpaceThreshold: 1_000_000_000,
      });
    });

    it('calls coordinator.start() and receives stop function', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      const coordinator = mockCreateCoordinator.mock.results[0]!.value;
      expect(coordinator.start).toHaveBeenCalledTimes(1);
    });

    it('keeps DB repo polling active when coordinator is enabled', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const request = makeWorkRequest({ issueNumber: 42 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockDetector.detectReadyWork).toHaveBeenCalled();
    });

    it('does NOT start standalone PO agent when coordinator is enabled', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      const agent = mockCreatePOAgent.mock.results[0];
      if (agent) {
        expect(agent.value.start).not.toHaveBeenCalled();
      }
    });

    it('does NOT start standalone TL scheduler when coordinator is enabled', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      const scheduler = mockCreateTechLeadScheduler.mock.results[0];
      if (scheduler) {
        expect(scheduler.value.start).not.toHaveBeenCalled();
      }
    });

    it('stops coordinator on shutdown', async () => {
      const mockStopCoordinator = vi.fn();
      mockCreateCoordinator.mockReturnValue({
        start: vi.fn().mockReturnValue(mockStopCoordinator),
      });
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await signalHandlers['SIGTERM']!();
      expect(mockStopCoordinator).toHaveBeenCalledTimes(1);
    });

    it('still starts review scheduler when coordinator is enabled', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      expect(mockCreateReviewScheduler).toHaveBeenCalledTimes(1);
    });
  });

  describe('knowledge store v1 migration wiring (#369)', () => {
    it('passes v1GotchaPath to KnowledgeStore constructor', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // KnowledgeStore(path, policies, v1GotchaPath)
      expect(knowledgeStoreCtorArgs).toHaveLength(3);
      expect(knowledgeStoreCtorArgs[0]).toMatch(/knowledge\.jsonl$/);
      expect(knowledgeStoreCtorArgs[2]).toMatch(/gotchas\.jsonl$/);
    });
  });

  describe('parked outcome handling', () => {
    it('does not increment consecutiveStuckCount on parked outcome', async () => {
      mockRunPipeline.mockResolvedValue({ outcome: 'parked' });

      const request = makeWorkRequest({ issueNumber: 10 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(0);
    });

    it('does not auto-pause daemon on parked outcome', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 1 });
      mockLoadConfig.mockResolvedValue(ok(config));
      mockRunPipeline.mockResolvedValue({ outcome: 'parked' });

      const request = makeWorkRequest({ issueNumber: 10 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        false,
      );
    });

    it('logs a message on parked outcome', async () => {
      mockRunPipeline.mockResolvedValue({ outcome: 'parked' });

      const request = makeWorkRequest({ issueNumber: 15 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('parked'),
      );
    });

    it('resets consecutiveStuckCount after parked follows stuck (parked is not stuck)', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 5 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({
        outcome: 'stuck',
        error: 'fail',
      });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(1);

      // Second run: parked — should NOT change consecutiveStuckCount
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'parked' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Parked is a no-op — stuck count stays at 1
      expect(
        (handlers.getStatus() as Record<string, unknown>)[
          'consecutiveStuckCount'
        ],
      ).toBe(1);
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(
        false,
      );
    });
  });

  describe('retry backoff', () => {
    it('skips issue in backoff window after it went stuck', async () => {
      const config = makeConfig({
        retryBackoffBaseMs: 60_000,
        retryBackoffMaxMs: 1_800_000,
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({
        outcome: 'stuck',
        error: 'fail',
      });
      const request = makeWorkRequest({ issueNumber: 42 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First poll — run goes stuck
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(42);

      mockDetector.claimWork.mockClear();
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      // Second poll immediately — should be in backoff window (60s base), skip
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(42);
    });

    it('allows retry after backoff window expires', async () => {
      const config = makeConfig({
        retryBackoffBaseMs: 1_000,
        retryBackoffMaxMs: 5_000,
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({
        outcome: 'stuck',
        error: 'fail',
      });
      const request = makeWorkRequest({ issueNumber: 42 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First poll — run goes stuck
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(42);

      mockDetector.claimWork.mockClear();
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      // Advance past backoff window (1s base, count=1 → backoff=1s)
      await vi.advanceTimersByTimeAsync(2_000);

      // Next poll — backoff expired, should retry
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(42);
    });
  });

  describe('parked-run resume scan', () => {
    const makeParkedRun = (overrides?: Record<string, unknown>) => ({
      id: 'run-parked-1',
      issueNumber: 100,
      title: 'Parked feature',
      phase: 'paused',
      pausedAtPhase: 'l2-gate',
      variant: 'feature',
      phaseCompletions: {
        detect: true,
        classify: true,
        'l1-design': true,
        'l2-design': true,
      },
      checkpoints: [],
      cost: 5,
      perRunBudget: 10,
      fixAttempts: [],
      errorHashes: {},
      repoOwner: 'test-owner',
      repoName: 'test-repo',
      body: 'Feature body',
      labels: ['feature-pipeline', 'l2-in-progress'],
      specRefs: ['FUNC-100'],
      l2GateNotified: true,
      startedAt: '2026-03-21T00:00:00Z',
      updatedAt: '2026-03-21T06:00:00Z',
      ...overrides,
    });

    it('resumes a parked run when l2-approved label is present', async () => {
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: {
          labels: [{ name: 'l2-approved' }, { name: 'awaiting-l2-review' }],
        },
      });
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // Trigger one poll cycle
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Should have fetched issue labels
      expect(mockOctokit.issues.get).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-owner',
          repo: 'test-repo',
          issue_number: 100,
        }),
      );
      // Should have removed awaiting-l2-review label (best-effort)
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'awaiting-l2-review',
          issue_number: 100,
        }),
      );
      // Should have reset state and re-entered pipeline
      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 100,
          phase: 'l2-gate',
          pausedAtPhase: undefined,
        }),
      );
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    it('persists the requeue (saveRunState) BEFORE removing gate labels (crash-safe ordering)', async () => {
      // REGRESSION: label removal is a remote, irreversible mutation. If it ran
      // before the durable save and the process crashed in between, the run would
      // restart still parked but with no trigger label -> stuck forever. Save must
      // commit first; a crash after save leaves the (now-unparked) run unaffected.
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'l2-approved' }, { name: 'awaiting-l2-review' }] },
      });
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const saveOrder = mockStateMgr.saveRunState.mock.invocationCallOrder[0];
      const removeOrder = mockOctokit.issues.removeLabel.mock.invocationCallOrder[0];
      expect(saveOrder).toBeDefined();
      expect(removeOrder).toBeDefined();
      expect(saveOrder!).toBeLessThan(removeOrder!);
    });

    it('resumes a parked run when l2-rejected label is present (FLAG OFF => l2-gate, no feedback, matches origin/main)', async () => {
      // FIX 2 (flag-OFF blocker): the rejected-resume routing change
      // (listComments() + l2Feedback capture + phase='l2-design' + clearing the
      // l2Gate/l2MergeBlocked notification flags) is gated behind
      // decisionManager.isEnabled(). With the flag OFF (no decisionManager
      // injected => default disabled) the behavior must be IDENTICAL to
      // origin/main: a rejected resume re-enters phase='l2-gate', no extra
      // listComments() call is made, l2Feedback is untouched, and l2GateNotified
      // stays as it was. This test asserts the gated-OFF outcome — it REPLACES the
      // earlier assertion that codified the ungated l2-design+feedback behavior.
      const parkedRun = makeParkedRun(); // l2GateNotified: true
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'l2-rejected' }] },
      });
      mockOctokit.issues.listComments.mockResolvedValue({
        data: [
          { body: 'Looks good so far' },
          { body: 'REJECTED: the proposal misses the caching layer requirement.' },
        ],
      });
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Re-enters l2-gate (NOT l2-design); no feedback captured; notification
      // flag untouched — exactly origin/main.
      const rejectedSave = mockStateMgr.saveRunState.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((s) => s.issueNumber === 100);
      expect(rejectedSave).toBeDefined();
      expect(rejectedSave?.phase).toBe('l2-gate');
      expect(rejectedSave?.pausedAtPhase).toBeUndefined();
      expect(rejectedSave?.l2Feedback).toBeUndefined();
      expect(rejectedSave?.l2GateNotified).toBe(true);
      // No extra GitHub round-trip when the flag is OFF.
      expect(mockOctokit.issues.listComments).not.toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    describe.skipIf(!REAL_PG)('decision-index enabled mode (real writer over real Postgres)', () => {
      const serializer = makeSchemaSerializer();
      let dir: string;
      let manager: DecisionIndexManager;

      // Seed a parked run whose ledger row is already at `notified` (the only
      // status answer() can proceed from). epoch=1 so decisionIdFor matches.
      const seedNotified = async (
        m: DecisionIndexManager,
        issueNumber: number,
      ) => {
        const req = buildL2GateRequest(
          {
            issueNumber,
            variant: 'feature',
            repoOwner: 'test-owner',
            repoName: 'test-repo',
          } as unknown as Parameters<typeof buildL2GateRequest>[0],
          1,
          'test-owner/test-repo',
        );
        const { decision_id } = await m.ledger().raise(req);
        await m.ledger().notify(decision_id);
        return decision_id;
      };

      beforeAll(() => serializer.lock());
      afterAll(() => serializer.release());

      beforeEach(async () => {
        // The real postgres-js writer drives connect via setTimeout and write-flush
        // via setImmediate, so those MUST stay REAL. The daemon poll loop is
        // setInterval-driven, so fake ONLY setInterval/clearInterval/Date here. The
        // parent beforeEach already installed a full useFakeTimers(); RESTORE real
        // timers first (re-configuring without this leaves setTimeout/setImmediate
        // faked → postgres-js hangs) then re-fake just the interval loop, so
        // advanceTimersByTimeAsync still drives the poll while Postgres works.
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await serializer.resetSchema();
        dir = mkdtempSync(join(tmpdir(), 'daemon-decision-'));
      });

      afterEach(async () => {
        await manager?.close();
        rmSync(dir, { recursive: true, force: true });
      });

      it('records the answer BEFORE save and drives the ledger to resumed AFTER save (crash-safe ordering)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 3).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-approved' }] },
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        // startDaemon calls manager.init() internally; seed AFTER it returns so
        // the row lands in the live writer.
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotified(manager, 100);

        // Prove the answer was recorded BEFORE the requeue commit. The async
        // Postgres writer means the row's status can no longer be sampled
        // synchronously inside the save mock, so compare invocation order of the
        // real ledger.answer vs the durable resume save (same approach as the
        // integrate-park CRASH-SAFE test).
        const answerSpy = vi.spyOn(manager.ledger(), 'answer');

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();
        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Answer recorded BEFORE the resume save committed (crash-safe ordering).
        expect(answerSpy).toHaveBeenCalled();
        const resumeSaveCall = mockStateMgr.saveRunState.mock.calls.findIndex((c) => {
          const s = c[0] as Record<string, unknown>;
          return s.issueNumber === 100 && s.pausedAtPhase === undefined;
        });
        expect(resumeSaveCall).toBeGreaterThanOrEqual(0);
        expect(answerSpy.mock.invocationCallOrder[0]!).toBeLessThan(
          mockStateMgr.saveRunState.mock.invocationCallOrder[resumeSaveCall]!,
        );
        // After the tick, advanceToResumed drove the row to terminal `resumed`
        // (terminal rows are excluded from pending()).
        const stillPending = (await manager.ledger().pending()).find(
          (d) => d.decision_id === decisionId,
        );
        expect(stillPending).toBeUndefined();
      });

      it('records the answer once when the resume tick sees the label twice (answered-once)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 4).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        // Return a FRESH parked copy each scan (same epoch=1 -> same decision id)
        // so two genuine resume attempts target the same ledger row. The second
        // answer() lands on a now-resumed row; the daemon must not crash and the
        // row must stay terminal (recorded once).
        mockStateMgr.findParkedRuns.mockImplementation(async () => [
          makeParkedRun({ decisionEpoch: 1 }),
        ]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-approved' }] },
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotified(manager, 100);

        // Two poll cycles, flushing microtasks between so the first resume's
        // .finally() clears activeIssues before the second scan.
        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();
        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Row reached terminal resumed exactly once (no crash on the replayed
        // answer; second attempt failed closed without re-opening the row).
        const stillPending = (await manager.ledger().pending()).find(
          (d) => d.decision_id === decisionId,
        );
        expect(stillPending).toBeUndefined();
      });

      it('requeues even when the ledger row is MISSING (answer no-ops; additive index never blocks resume)', async () => {
        // The index is additive — the GitHub-label requeue is the v1 source of
        // truth. If raise never landed (index broken/disabled at park, enabled at
        // resume), answer() on the absent row must no-op, NOT throw-and-fail-closed
        // and strand the run. The label-driven requeue must still fire.
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 5).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-approved' }] },
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        // INTENTIONALLY do not seed a ledger row (simulate raise-never-landed).

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Not stuck: the requeue committed (phase reset) and the pipeline re-entered.
        expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
          expect.objectContaining({
            issueNumber: 100,
            phase: 'l2-gate',
            pausedAtPhase: undefined,
          }),
        );
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('runs a periodic reconcile each tick (recovers crash-stranded in-flight effects)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 6).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });
        mockStateMgr.findParkedRuns.mockResolvedValue([]);

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        // Spy AFTER init so the boot reconcile is excluded — we assert the TICK
        // sweep, which is what recovers a crash that happened post-boot.
        const reconcileSpy = vi.spyOn(manager.ledger(), 'reconcile');

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        expect(reconcileSpy).toHaveBeenCalled();
      });

      it('stays parked (fail-closed) when enabled but the ledger is broken', async () => {
        // A manager that is enabled but whose ledger() throws /unavailable/.
        const broken = {
          isEnabled: () => true,
          init: async () => undefined,
          close: async () => undefined,
          ledger: () => {
            throw new Error('decision index unavailable');
          },
        } as unknown as DecisionIndexManager;

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-approved' }] },
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: broken });

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Fail-closed: no requeue this tick, no pipeline re-entry, no phase reset.
        expect(mockRunPipeline).not.toHaveBeenCalled();
        const resetSaves = mockStateMgr.saveRunState.mock.calls.filter(
          (c) =>
            (c[0] as Record<string, unknown>).issueNumber === 100 &&
            (c[0] as Record<string, unknown>).pausedAtPhase === undefined,
        );
        expect(resetSaves).toHaveLength(0);
      });

      it('FLAG ON: l2-rejected resume routes to l2-design, captures feedback, and clears notification flags', async () => {
        // FIX 2 (flag-ON path): the gated routing change fires only when the
        // decision index is enabled. A rejected resume must capture the rejection
        // comment into run.l2Feedback, route the run to phase='l2-design', and
        // reset l2GateNotified / l2MergeBlockedNotified so the next park
        // re-notifies. This is the correct new behavior — gated, not reverted.
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 9).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 }); // l2GateNotified: true
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-rejected' }] },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [
            { body: 'Looks good so far' },
            { body: 'REJECTED: the proposal misses the caching layer requirement.' },
          ],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        // Seed the ledger row at `notified` so answer('reject') can proceed.
        await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Extra GitHub round-trip happens ONLY when enabled.
        expect(mockOctokit.issues.listComments).toHaveBeenCalledWith(
          expect.objectContaining({ issue_number: 100 }),
        );
        const rejectedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100);
        expect(rejectedSave).toBeDefined();
        expect(rejectedSave?.phase).toBe('l2-design');
        expect(rejectedSave?.pausedAtPhase).toBeUndefined();
        expect(rejectedSave?.l2Feedback).toBe(
          'REJECTED: the proposal misses the caching layer requirement.',
        );
        expect(rejectedSave?.l2GateNotified).toBe(false);
        expect(rejectedSave?.l2MergeBlockedNotified).toBeUndefined();
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('FLAG ON: sanitizes {{placeholder}} patterns and caps length when capturing rejection feedback', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 10).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'l2-rejected' }] },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [{ body: `REJECTED: ${'x'.repeat(5000)} {{inject}} done` }],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const rejectedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.phase === 'l2-design');
        expect(rejectedSave).toBeDefined();
        const feedback = rejectedSave?.l2Feedback as string;
        expect(feedback).toHaveLength(4000);
        expect(feedback).not.toContain('{{');
      });
    });

    // ----------------------------------------------------------------------
    // SLICE 2: ANSWER -> RESUME consumer. The cockpit answers via a
    // `**DecisionResponse**` comment (decision_id-matched) + `answered`/`ready`
    // labels — NOT the legacy `l2-approved`/`l2-rejected` labels. These tests
    // close the loop: the EXACT parked run re-enters, idempotently, with NO
    // double-resume and NO duplicate run.
    // ----------------------------------------------------------------------
    describe.skipIf(!REAL_PG)('cockpit answer consumer (Slice 2)', () => {
      const serializer = makeSchemaSerializer();
      let dir: string;
      let manager: DecisionIndexManager;

      /**
       * Build the cockpit's REAL DecisionResponse comment for a decision_id + option.
       * Mirrors pm-cockpit github-source-sink.ts `renderAnswerComment`: the
       * decision_id is bound ONLY in the effect marker
       * (`pm-cockpit:effect:<decisionId>:write_response:<idemKey>:etag=<etag>`,
       * effectId per @pm/index idempotency.ts), and the fenced JSON is MINIMAL —
       * just `{ chosen_option }`, no decision_id/answerer/answered_at/idempotency_key.
       */
      const decisionResponseComment = (
        decisionId: string,
        chosenOption: string,
      ): { body: string } => {
        const effectId = `${decisionId}:write_response:idem-${chosenOption}`;
        const marker = `<!-- pm-cockpit:effect:${effectId}:etag=sha256:etag-abc -->`;
        const payload = JSON.stringify({ chosen_option: chosenOption });
        return {
          body: [marker, '**DecisionResponse**', '```json', payload, '```'].join(
            '\n',
          ),
        };
      };

      const seedNotified = async (
        m: DecisionIndexManager,
        issueNumber: number,
      ) => {
        const req = buildL2GateRequest(
          {
            issueNumber,
            variant: 'feature',
            repoOwner: 'test-owner',
            repoName: 'test-repo',
          } as unknown as Parameters<typeof buildL2GateRequest>[0],
          1,
          'test-owner/test-repo',
        );
        const { decision_id } = await m.ledger().raise(req);
        await m.ledger().notify(decision_id);
        return decision_id;
      };

      beforeAll(() => serializer.lock());
      afterAll(() => serializer.release());

      beforeEach(async () => {
        // Keep setTimeout/setImmediate REAL for the postgres-js writer; fake only the
        // setInterval-driven poll loop. See the rationale in the enabled-mode describe.
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await serializer.resetSchema();
        dir = mkdtempSync(join(tmpdir(), 'daemon-cockpit-'));
      });
      afterEach(async () => {
        await manager?.close();
        rmSync(dir, { recursive: true, force: true });
      });

      it('HAPPY PATH: cockpit approve (answered label + DecisionResponse) re-enters the SAME run past l2-gate, no duplicate from ready', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 20).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        // Cockpit state: answered + ready labels, NO legacy l2-approved label.
        mockOctokit.issues.get.mockResolvedValue({
          data: {
            labels: [{ name: 'answered' }, { name: 'ready' }],
            state: 'open',
          },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:l2-gate:1', 'approve')],
        });
        // The cockpit's `ready` label would normally be seen as fresh work — assert
        // it is NOT claimed as a duplicate run (the issue is decision-owned).
        mockDetector.detectReadyWork.mockResolvedValue(
          ok([makeWorkRequest({ issueNumber: 100, labels: ['ready'] })]),
        );
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // NO duplicate run: detectReadyWork's claim must NOT have fired for #100.
        expect(mockDetector.claimWork).not.toHaveBeenCalledWith(100);
        // The SAME run re-entered: phase reset to l2-gate, pausedAtPhase cleared.
        const resumedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(resumedSave).toBeDefined();
        expect(resumedSave?.phase).toBe('l2-gate');
        // approve synthesizes the l2-approved label so the l2-gate handler advances.
        expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
          expect.objectContaining({ issue_number: 100, labels: ['l2-approved'] }),
        );
        // The ledger reached terminal resumed exactly once.
        expect(await manager.ledger().statusOf(decisionId)).toBe('resumed');
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('DOUBLE-DELIVERY: same answer seen across two ticks AND exposed to both pollers re-enters EXACTLY ONCE', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 21).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        // Fresh parked copy each scan (same epoch=1 -> same decision id) so two
        // genuine resume attempts target the same ledger row.
        mockStateMgr.findParkedRuns.mockImplementation(async () => [
          makeParkedRun({ decisionEpoch: 1 }),
        ]);
        mockOctokit.issues.get.mockResolvedValue({
          data: {
            labels: [{ name: 'answered' }, { name: 'ready' }],
            state: 'open',
          },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:l2-gate:1', 'approve')],
        });
        // Also expose the SAME issue to the new-work poll (the cockpit's ready label).
        mockDetector.detectReadyWork.mockResolvedValue(
          ok([makeWorkRequest({ issueNumber: 100, labels: ['ready'] })]),
        );
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotified(manager, 100);

        // Two full poll cycles (the answer is "delivered"/seen twice).
        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();
        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // EXACTLY ONE re-entry: the new-work poll never claimed #100, and the run
        // re-entered the pipeline exactly once across both ticks.
        expect(mockDetector.claimWork).not.toHaveBeenCalledWith(100);
        const resumeReentries = mockRunPipeline.mock.calls.filter((c) => {
          const run = c[0] as Record<string, unknown>;
          return run.issueNumber === 100;
        });
        expect(resumeReentries).toHaveLength(1);
        // Terminal resumed (recorded once; the replayed answer did not re-open it).
        expect(await manager.ledger().statusOf(decisionId)).toBe('resumed');
      });

      it('REJECT PATH: cockpit reject lands at l2-design with l2Feedback populated from the rejection comment', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 22).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        const rejectComment = decisionResponseComment(
          'issue-100:l2-gate:1',
          'reject',
        );
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [rejectComment],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const rejectedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(rejectedSave).toBeDefined();
        expect(rejectedSave?.phase).toBe('l2-design');
        // FEEDBACK CONTENT must reach l2-design (not merely that it routed there).
        const feedback = rejectedSave?.l2Feedback as string;
        expect(feedback).toBeDefined();
        expect(feedback).toContain('"chosen_option":"reject"');
        expect(rejectedSave?.l2GateNotified).toBe(false);
        // reject does NOT synthesize an l2-approved label.
        expect(mockOctokit.issues.addLabels).not.toHaveBeenCalledWith(
          expect.objectContaining({ labels: ['l2-approved'] }),
        );
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('NO-ANSWER: answered/ready labels present but NO matching DecisionResponse comment -> stays parked', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 23).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        // Half-written cockpit state: labels flipped but no DecisionResponse yet,
        // OR a response for a DIFFERENT epoch. Either way: do nothing.
        mockOctokit.issues.get.mockResolvedValue({
          data: {
            labels: [{ name: 'answered' }, { name: 'ready' }],
            state: 'open',
          },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:l2-gate:2', 'approve')], // wrong epoch
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Stays parked: no phase reset, no pipeline re-entry, ledger still notified.
        const resetSaves = mockStateMgr.saveRunState.mock.calls.filter(
          (c) =>
            (c[0] as Record<string, unknown>).issueNumber === 100 &&
            (c[0] as Record<string, unknown>).pausedAtPhase === undefined,
        );
        expect(resetSaves).toHaveLength(0);
        expect(mockRunPipeline).not.toHaveBeenCalled();
        expect(await manager.ledger().statusOf(decisionId)).toBe('notified');
      });

      it('removes the ready label on a committed cockpit resume (closes the duplicate-work loop)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 24).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeParkedRun({ decisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: {
            labels: [{ name: 'answered' }, { name: 'ready' }],
            state: 'open',
          },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:l2-gate:1', 'approve')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        await seedNotified(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'ready', issue_number: 100 }),
        );
      });
    });

    // ----------------------------------------------------------------------
    // FOLLOW-UP #9: integrate-park resume lifecycle. A run parked at the
    // `integrate` phase (merge-decision gate held/escalated the change) resumes
    // ONLY via a cockpit DecisionResponse for `issue-<n>:integrate:<epoch>` (the
    // integrate park requires the decision index enabled — no legacy-label path).
    //   - APPROVE → run re-enters `integrate` with mergeDecisionApprovedEpoch set
    //     to the current mergeDecisionEpoch (the integrate-handler override then
    //     executes the held merge instead of re-parking).
    //   - REJECT  → run routes to `implement` with mergeDecisionFeedback captured
    //     and mergeDecisionBlockPublished reset so a future park re-publishes.
    // Mirrors the l2-gate cockpit consumer harness; the l2-gate path stays
    // byte-identical (a separate, parallel branch handles `integrate`).
    // RED until Kimi adds the integrate branch to resumeParkedRuns.
    // ----------------------------------------------------------------------
    describe.skipIf(!REAL_PG)('integrate park resume (follow-up #9)', () => {
      const serializer = makeSchemaSerializer();
      let dir: string;
      let manager: DecisionIndexManager;

      const makeIntegrateParkedRun = (overrides?: Record<string, unknown>) => ({
        id: 'run-parked-integrate-1',
        issueNumber: 100,
        title: 'Parked at integrate',
        phase: 'paused',
        pausedAtPhase: 'integrate',
        variant: 'feature',
        phaseCompletions: {
          detect: true,
          classify: true,
          'l1-design': true,
          'l2-design': true,
          implement: true,
        },
        checkpoints: [],
        cost: 5,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        body: 'Feature body',
        labels: ['feature-pipeline'],
        specRefs: ['FUNC-100'],
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T06:00:00Z',
        // The integrate park bumps this epoch; the resume keys off it.
        mergeDecisionEpoch: 1,
        mergeDecisionBlockPublished: true,
        ...overrides,
      });

      // The cockpit's DecisionResponse comment, decision_id bound ONLY in the
      // effect marker, minimal `{ chosen_option }` JSON (same shape the l2-gate
      // consumer tests use — the marker keys on the decision_id, not the JSON).
      const decisionResponseComment = (
        decisionId: string,
        chosenOption: string,
      ): { body: string } => {
        const effectId = `${decisionId}:write_response:idem-${chosenOption}`;
        const marker = `<!-- pm-cockpit:effect:${effectId}:etag=sha256:etag-abc -->`;
        const payload = JSON.stringify({ chosen_option: chosenOption });
        return {
          body: [marker, '**DecisionResponse**', '```json', payload, '```'].join(
            '\n',
          ),
        };
      };

      // Seed the merge-decision ledger row to `notified` (the only status answer()
      // proceeds from) for `issue-<n>:integrate:<epoch>` with epoch=1.
      const seedNotifiedIntegrate = async (
        m: DecisionIndexManager,
        issueNumber: number,
      ) => {
        // Only `kind` + `effectiveRisk` are read by the builder (context text +
        // risk_class mapping); a partial cast is sufficient to seed the row.
        const decision = {
          kind: 'escalate',
          effectiveRisk: 'green',
        } as unknown as MergeDecision;
        const req = buildMergeDecisionRequest(
          {
            issueNumber,
            variant: 'feature',
            repoOwner: 'test-owner',
            repoName: 'test-repo',
          } as unknown as Parameters<typeof buildMergeDecisionRequest>[0],
          1,
          'test-owner/test-repo',
          decision,
        );
        const { decision_id } = await m.ledger().raise(req);
        await m.ledger().notify(decision_id);
        return decision_id;
      };

      beforeAll(() => serializer.lock());
      afterAll(() => serializer.release());

      beforeEach(async () => {
        // Keep setTimeout/setImmediate REAL for the postgres-js writer; fake only the
        // setInterval-driven poll loop. See the rationale in the enabled-mode describe.
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        await serializer.resetSchema();
        dir = mkdtempSync(join(tmpdir(), 'daemon-integrate-park-'));
      });
      afterEach(async () => {
        await manager?.close();
        rmSync(dir, { recursive: true, force: true });
      });

      it('APPROVE: cockpit approve re-enters integrate with mergeDecisionApprovedEpoch === mergeDecisionEpoch, pausedAtPhase cleared, ledger answered+resumed', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 30).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeIntegrateParkedRun({ mergeDecisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:integrate:1', 'approve')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotifiedIntegrate(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const resumedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(resumedSave).toBeDefined();
        // Re-enters integrate (NOT advanced past, NOT routed to implement).
        expect(resumedSave?.phase).toBe('integrate');
        // The override key: approved epoch === current park epoch (one-shot).
        expect(resumedSave?.mergeDecisionApprovedEpoch).toBe(1);
        expect(resumedSave?.mergeDecisionEpoch).toBe(1);
        // The ledger reached terminal resumed exactly once.
        expect(await manager.ledger().statusOf(decisionId)).toBe('resumed');
        expect(mockRunPipeline).toHaveBeenCalled();
        // T1.6 — THROUGH THE MERGE: the run handed back to the pipeline carries the
        // operator-approved override ARMED (mergeDecisionApprovedEpoch === current
        // mergeDecisionEpoch). That is the EXACT precondition the integrate handler
        // checks (`phases.ts` `decision.kind === 'auto-merge' || approvedEpoch ===
        // epoch`) before executing the held merge via integrateToStaging. This
        // real-PG test proves the WRITER semantics (answer + advanceToResumed over
        // real Postgres) drive the run to the merge-armed state; the held merge's
        // actual EXECUTION (integrateToStaging CALLED on this precondition) is proven
        // CI-default by the real integrate handler in
        // merge-decision-wiring.integration.test.ts (h).
        const reenteredRun = mockRunPipeline.mock.calls[0]?.[0] as Record<
          string,
          unknown
        >;
        expect(reenteredRun?.mergeDecisionApprovedEpoch).toBe(
          reenteredRun?.mergeDecisionEpoch,
        );
        expect(reenteredRun?.mergeDecisionApprovedEpoch).toBe(1);
        expect(reenteredRun?.phase).toBe('integrate');
        // The cockpit `ready` requeue label is stripped so detectReadyWork cannot
        // reclaim the resumed issue and start a duplicate run (codex r5).
        expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(
          expect.objectContaining({ issue_number: 100, name: 'ready' }),
        );
      });

      it('APPROVE (legacy/migrated): a parked run with NO mergeDecisionEpoch resolves the epoch to 1 and stores it on BOTH fields so the integrate handler honors it (codex r4)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 31).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        // A run parked before mergeDecisionEpoch existed: the field is absent. The
        // resume branch must default it to 1 for the decision id AND persist 1 onto
        // mergeDecisionEpoch + mergeDecisionApprovedEpoch — otherwise the integrate
        // handler's `mergeDecisionEpoch !== undefined` honor check fails and the
        // approved run re-parks while the ledger is already `resumed` (stranded).
        const parkedRun = makeIntegrateParkedRun({ mergeDecisionEpoch: undefined });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:integrate:1', 'approve')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotifiedIntegrate(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const resumedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(resumedSave).toBeDefined();
        expect(resumedSave?.phase).toBe('integrate');
        // Both fields defaulted to 1 and EQUAL — the override is honorable.
        expect(resumedSave?.mergeDecisionEpoch).toBe(1);
        expect(resumedSave?.mergeDecisionApprovedEpoch).toBe(1);
        expect(await manager.ledger().statusOf(decisionId)).toBe('resumed');
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('APPROVE (pre-rename park): a stored request whose approve option is the legacy `approve-merge` resumes — the daemon answers the ledger with the RAW id so state-machine option validation passes (codex P1)', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 32).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeIntegrateParkedRun({ mergeDecisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        // The operator answered with the legacy displayed option id.
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:integrate:1', 'approve-merge')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });

        // Seed a request whose stored options use the PRE-RENAME approve id. The
        // state machine validates the answered chosen_option against THESE options,
        // so the daemon must answer with `approve-merge`, not the normalized id.
        const decision = {
          kind: 'escalate',
          effectiveRisk: 'green',
        } as unknown as MergeDecision;
        const built = buildMergeDecisionRequest(
          {
            issueNumber: 100,
            variant: 'feature',
            repoOwner: 'test-owner',
            repoName: 'test-repo',
          } as unknown as Parameters<typeof buildMergeDecisionRequest>[0],
          1,
          'test-owner/test-repo',
          decision,
        );
        const legacyReq = {
          ...built,
          options: [
            { id: 'approve-merge', label: 'Approve the merge and resume the pipeline.' },
            { id: 'reject', label: 'Reject and send back for rework.' },
          ],
        };
        const { decision_id } = await manager.ledger().raise(legacyReq);
        await manager.ledger().notify(decision_id);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const resumedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(resumedSave).toBeDefined();
        expect(resumedSave?.phase).toBe('integrate');
        expect(resumedSave?.mergeDecisionApprovedEpoch).toBe(1);
        // The ledger ACCEPTED the raw `approve-merge` answer and reached resumed —
        // it would have thrown AnswerRejectedError on a normalized `approve`.
        expect(await manager.ledger().statusOf(decision_id)).toBe('resumed');
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('REJECT: cockpit reject routes to implement with mergeDecisionFeedback captured + mergeDecisionBlockPublished reset, ledger answered+resumed', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 31).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeIntegrateParkedRun({
          mergeDecisionEpoch: 1,
          mergeDecisionBlockPublished: true,
        });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:integrate:1', 'reject')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotifiedIntegrate(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const rejectedSave = mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find((s) => s.issueNumber === 100 && s.pausedAtPhase === undefined);
        expect(rejectedSave).toBeDefined();
        // Reject sends the change back for rework (route to implement directly,
        // mirroring l2-gate reject → l2-design).
        expect(rejectedSave?.phase).toBe('implement');
        // Operator feedback reaches the rework cycle.
        const feedback = rejectedSave?.mergeDecisionFeedback as string;
        expect(feedback).toBeDefined();
        expect(feedback).toContain('"chosen_option":"reject"');
        // Reset so a FUTURE park re-publishes a fresh decision block.
        expect(rejectedSave?.mergeDecisionBlockPublished).toBe(false);
        // No approve override is set on a reject.
        expect(rejectedSave?.mergeDecisionApprovedEpoch).toBeUndefined();
        expect(await manager.ledger().statusOf(decisionId)).toBe('resumed');
        expect(mockRunPipeline).toHaveBeenCalled();
      });

      it('NO-ANSWER: notified but NO matching DecisionResponse for this epoch -> stays parked at integrate', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 32).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeIntegrateParkedRun({ mergeDecisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          // Wrong epoch — not authoritative for this park.
          data: [decisionResponseComment('issue-100:integrate:2', 'approve')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        const decisionId = await seedNotifiedIntegrate(manager, 100);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Stays parked: no resume-save (pausedAtPhase cleared) happened.
        const resetSaves = mockStateMgr.saveRunState.mock.calls.filter(
          (c) =>
            (c[0] as Record<string, unknown>).issueNumber === 100 &&
            (c[0] as Record<string, unknown>).pausedAtPhase === undefined,
        );
        expect(resetSaves).toHaveLength(0);
        expect(mockRunPipeline).not.toHaveBeenCalled();
        expect(await manager.ledger().statusOf(decisionId)).toBe('notified');
      });

      it('CRASH-SAFE: ledger.answer is recorded BEFORE saveRunState on an integrate resume', async () => {
        manager = new DecisionIndexManager({
          enabled: true,
          databaseUrl: DECISION_DB_URL!,
          protectedKey: Buffer.alloc(32, 33).toString('base64'),
          protectedDir: join(dir, 'protected'),
        });

        const parkedRun = makeIntegrateParkedRun({ mergeDecisionEpoch: 1 });
        mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment('issue-100:integrate:1', 'approve')],
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', { decisionManager: manager });
        await seedNotifiedIntegrate(manager, 100);

        // Spy on the REAL ledger's answer so its call order can be compared.
        // seedNotifiedIntegrate above forces ledger init, so the singleton exists.
        const answerSpy = vi.spyOn(manager.ledger(), 'answer');

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Both must have happened, and answer must precede the durable save so a
        // crash between them never advances on an unrecorded answer.
        expect(answerSpy).toHaveBeenCalled();
        const resumeSaveCall = mockStateMgr.saveRunState.mock.calls.findIndex(
          (c) => {
            const s = c[0] as Record<string, unknown>;
            return s.issueNumber === 100 && s.pausedAtPhase === undefined;
          },
        );
        expect(resumeSaveCall).toBeGreaterThanOrEqual(0);
        const answerOrder = answerSpy.mock.invocationCallOrder[0];
        const saveOrder =
          mockStateMgr.saveRunState.mock.invocationCallOrder[resumeSaveCall];
        expect(answerOrder).toBeDefined();
        expect(saveOrder).toBeDefined();
        expect(answerOrder!).toBeLessThan(saveOrder!);
      });
    });

    // --- CI-default (no Postgres) joined round-trip via the T1.4 lifecycle fake --
    // resumeIntegrateParkedRun is PRIVATE — driven here through the PUBLIC
    // startDaemon + poll-tick harness with the fake injected (mirrors the real-PG
    // describe above, minus Postgres). This proves the RESUME half of A2:
    //   approve -> mergeDecisionApprovedEpoch === mergeDecisionEpoch (the integrate
    //     override's exact precondition) + ledger driven to 'resumed';
    //   reject  -> routed to implement with feedback + block-published reset;
    //   already-resumed -> idempotent no-op (answer-once at the daemon level).
    // The MERGE half (approvedEpoch armed -> integrateToStaging CALLED on approve,
    // NOT called on reject) is proven CI-default by the real integrate handler in
    // merge-decision-wiring.integration.test.ts (h)/(a) — daemon.test.ts mocks
    // createPhaseHandlers + runPipeline, so the handler never runs in THIS harness.
    describe('integrate park resume (round-trip, CI-default fake — no Postgres)', () => {
      const DECISION_ID = 'issue-100:integrate:1';

      const makeIntegrateParkedRun = (
        overrides?: Record<string, unknown>,
      ): Record<string, unknown> => ({
        id: 'run-parked-integrate-fake',
        issueNumber: 100,
        title: 'Parked at integrate',
        phase: 'paused',
        pausedAtPhase: 'integrate',
        variant: 'feature',
        phaseCompletions: {
          detect: true,
          classify: true,
          'l1-design': true,
          'l2-design': true,
          implement: true,
        },
        checkpoints: [],
        cost: 5,
        perRunBudget: 10,
        fixAttempts: [],
        errorHashes: {},
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        body: 'Feature body',
        labels: ['feature-pipeline'],
        specRefs: ['FUNC-100'],
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T06:00:00Z',
        mergeDecisionEpoch: 1,
        mergeDecisionBlockPublished: true,
        ...overrides,
      });

      const decisionResponseComment = (
        decisionId: string,
        chosenOption: string,
      ): { body: string } => {
        const effectId = `${decisionId}:write_response:idem-${chosenOption}`;
        const marker = `<!-- pm-cockpit:effect:${effectId}:etag=sha256:etag-abc -->`;
        const payload = JSON.stringify({ chosen_option: chosenOption });
        return {
          body: [marker, '**DecisionResponse**', '```json', payload, '```'].join(
            '\n',
          ),
        };
      };

      // A minimal VALID deployment profile (mirrors merge-decision-wiring's
      // makeProfile) so a governed config registers + boots past the A1 guard.
      const validProfile = (): Record<string, unknown> => ({
        repositories: [{ owner: 'test-owner', name: 'test-repo' }],
        riskPathMap: [],
        defaultMinLevel: 'green',
        laneSet: {
          declaredPhases: ['velocity'],
          mostCautiousLane: 'standard',
          lanes: [
            {
              name: 'auto',
              qualify: { complexity: ['simple'], changeKind: ['docs'] },
              allowedPaths: ['docs/**'],
              roleRouting: {},
              gateSet: 'gate1',
              mergePolicy: 'auto',
              verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
            },
            {
              name: 'standard',
              qualify: { complexity: ['standard', 'complex'] },
              allowedPaths: ['**'],
              roleRouting: {},
              gateSet: 'full',
              mergePolicy: 'hold',
              verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
            },
          ],
        },
        lifecycleMode: 'velocity',
        complianceReviewers: [],
        honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
        budget: 1000,
        landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
        capabilityBindings: [],
      });

      beforeEach(() => {
        // Mirror the real-PG describe: fake only the setInterval poll loop + Date.
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
        mockOctokit.issues.get.mockResolvedValue({
          data: { labels: [{ name: 'answered' }], state: 'open' },
        });
        mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
      });

      const resumedSaveFor = (issueNumber: number) =>
        mockStateMgr.saveRunState.mock.calls
          .map((c) => c[0] as Record<string, unknown>)
          .find(
            (s) => s.issueNumber === issueNumber && s.pausedAtPhase === undefined,
          );

      it('APPROVE: re-enters integrate MERGE-ARMED (approvedEpoch === epoch), ledger driven to resumed', async () => {
        const { manager, ledger } = createFakeDecisionManager();
        mockStateMgr.findParkedRuns.mockResolvedValue([makeIntegrateParkedRun()]);
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment(DECISION_ID, 'approve')],
        });

        const { startDaemon } = await loadDaemon();
        const boot = await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        expect(boot.ok).toBe(true);
        ledger.seedNotified(DECISION_ID, ['approve', 'reject']);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const resumed = resumedSaveFor(100);
        expect(resumed).toBeDefined();
        // The integrate override's EXACT precondition: approved epoch == park epoch.
        expect(resumed?.phase).toBe('integrate');
        expect(resumed?.mergeDecisionApprovedEpoch).toBe(1);
        expect(resumed?.mergeDecisionEpoch).toBe(1);
        // The ledger reached terminal resumed (the fake's advanceToResumed).
        expect(await ledger.statusOf(DECISION_ID)).toBe('resumed');
        // The merge-armed run was handed to the pipeline for re-entry.
        expect(mockRunPipeline).toHaveBeenCalled();
        const reenteredRun = mockRunPipeline.mock.calls[0]?.[0] as Record<
          string,
          unknown
        >;
        expect(reenteredRun?.mergeDecisionApprovedEpoch).toBe(1);
      });

      it('REJECT: routes to implement with feedback + block-published reset, ledger resumed, NO approve override', async () => {
        const { manager, ledger } = createFakeDecisionManager();
        mockStateMgr.findParkedRuns.mockResolvedValue([makeIntegrateParkedRun()]);
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment(DECISION_ID, 'reject')],
        });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        ledger.seedNotified(DECISION_ID, ['approve', 'reject']);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        const resumed = resumedSaveFor(100);
        expect(resumed).toBeDefined();
        expect(resumed?.phase).toBe('implement');
        expect(resumed?.mergeDecisionApprovedEpoch).toBeUndefined();
        expect(resumed?.mergeDecisionBlockPublished).toBe(false);
        const feedback = resumed?.mergeDecisionFeedback as string;
        expect(feedback).toContain('"chosen_option":"reject"');
        expect(await ledger.statusOf(DECISION_ID)).toBe('resumed');
      });

      it('IDEMPOTENT (answer-once at the daemon): an already-resumed decision is a no-op (no re-consume, no re-run)', async () => {
        const { manager, ledger } = createFakeDecisionManager();
        mockStateMgr.findParkedRuns.mockResolvedValue([makeIntegrateParkedRun()]);
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment(DECISION_ID, 'approve')],
        });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        // Seed a terminal `resumed` row directly (a prior cycle already consumed
        // it). seedResumed — NOT advanceToResumed on a notified row — because the
        // fake (like the real ledger) only reaches resumed from the answered state.
        ledger.seedResumed(DECISION_ID, ['approve', 'reject']);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // The idempotency guard short-circuits: no resume-save, no re-run.
        expect(resumedSaveFor(100)).toBeUndefined();
        expect(mockRunPipeline).not.toHaveBeenCalled();
      });

      it('GOVERNED APPROVE: a successful resume CLEARS the runtime-degraded marker (advanceToResumed success)', async () => {
        const { manager, ledger } = createFakeDecisionManager();
        // A prior approval-path failure had marked the index runtime-degraded.
        manager.markRuntimeDegraded('earlier transient failure');
        expect(manager.isRuntimeDegraded()).toBe(true);

        mockLoadConfig.mockResolvedValue(
          ok(
            makeConfig({
              deployment: { id: 'dep-a', profile: validProfile() },
            }),
          ),
        );
        mockStateMgr.findParkedRuns.mockResolvedValue([makeIntegrateParkedRun()]);
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment(DECISION_ID, 'approve')],
        });

        const { startDaemon } = await loadDaemon();
        const boot = await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        expect(boot.ok).toBe(true); // governed + available fake → boots past A1.
        ledger.seedNotified(DECISION_ID, ['approve', 'reject']);

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        expect(resumedSaveFor(100)).toBeDefined();
        // The successful governed advanceToResumed cleared the marker.
        expect(manager.degradedClears).toBeGreaterThanOrEqual(1);
        expect(manager.isRuntimeDegraded()).toBe(false);
      });

      it('GOVERNED: a resume-path ledger failure MARKS runtime-degraded and stays parked (fail-closed)', async () => {
        const { manager, ledger } = createFakeDecisionManager();
        mockLoadConfig.mockResolvedValue(
          ok(
            makeConfig({
              deployment: { id: 'dep-a', profile: validProfile() },
            }),
          ),
        );
        mockStateMgr.findParkedRuns.mockResolvedValue([makeIntegrateParkedRun()]);
        mockOctokit.issues.listComments.mockResolvedValue({
          data: [decisionResponseComment(DECISION_ID, 'approve')],
        });

        const { startDaemon } = await loadDaemon();
        await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        ledger.seedNotified(DECISION_ID, ['approve', 'reject']);
        // The decision-index answer() throws at runtime (e.g. Postgres dropped).
        vi.spyOn(ledger, 'answer').mockRejectedValueOnce(
          new Error('postgres connection lost'),
        );

        await vi.advanceTimersByTimeAsync(30000);
        await vi.advanceTimersByTimeAsync(0);
        await settleRealAsync();

        // Fail-closed: the run stays parked (no resume-save), and the governed
        // failure marked the index runtime-degraded (observable at /health).
        expect(resumedSaveFor(100)).toBeUndefined();
        expect(manager.degradedMarks.length).toBeGreaterThanOrEqual(1);
        expect(manager.isRuntimeDegraded()).toBe(true);
      });
    });

    // --- governed decision-index /health signal (first-use PR1) ---------------
    // getHealth() is the minimal signal the real control server's /health handler
    // maps to 503. A GOVERNED daemon (deployment profile configured) is unhealthy
    // when its approval transport is down — runtime-degraded marker set, OR
    // enabled-but-unreachable. A non-governed daemon's index state never makes it
    // unhealthy. (The full stuck/watchdog/pauseReason mapping is PR2/T2.6.)
    describe('governed decision-index /health signal (first-use PR1)', () => {
      const validProfile = (): Record<string, unknown> => ({
        repositories: [{ owner: 'test-owner', name: 'test-repo' }],
        riskPathMap: [],
        defaultMinLevel: 'green',
        laneSet: {
          declaredPhases: ['velocity'],
          mostCautiousLane: 'standard',
          lanes: [
            {
              name: 'standard',
              qualify: { complexity: ['standard', 'complex'] },
              allowedPaths: ['**'],
              roleRouting: {},
              gateSet: 'full',
              mergePolicy: 'hold',
              verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
            },
          ],
        },
        lifecycleMode: 'velocity',
        complianceReviewers: [],
        honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
        budget: 1000,
        landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
        capabilityBindings: [],
      });

      const bootGoverned = async (manager: ReturnType<typeof createFakeDecisionManager>['manager']) => {
        // Configure an alert channel so this PR1 decision-index health test is not
        // also tripped by PR2's B2 governed-without-channel degraded signal.
        mockLoadConfig.mockResolvedValue(
          ok(
            makeConfig({
              webhooks: ['https://hooks.example.com/test'],
              deployment: { id: 'dep-a', profile: validProfile() },
            }),
          ),
        );
        const { startDaemon } = await loadDaemon();
        const { createControlServer } = await import('./server.js');
        const result = await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        expect(result.ok).toBe(true);
        return vi.mocked(createControlServer).mock.lastCall![1];
      };

      it('governed + runtime-degraded marker set → getHealth unhealthy (503 mapping) + /status surfaces it', async () => {
        const { manager } = createFakeDecisionManager(); // available at boot
        const handlers = await bootGoverned(manager);
        manager.markRuntimeDegraded('postgres dropped after boot');

        expect(handlers.getHealth!()).toEqual({
          ok: false,
          degraded: true,
          reason: 'decision-index-unavailable',
        });
        const status = handlers.getStatus() as Record<string, unknown>;
        expect(status.isGoverned).toBe(true);
        expect(status.isRuntimeDegraded).toBe(true);
      });

      it('governed + enabled-but-unreachable at runtime → getHealth unhealthy', async () => {
        const { manager } = createFakeDecisionManager(); // available at boot (passes A1)
        const handlers = await bootGoverned(manager);
        manager.setAvailable(false); // the index became unreachable AFTER boot

        expect(handlers.getHealth!()).toEqual({
          ok: false,
          degraded: true,
          reason: 'decision-index-unavailable',
        });
      });

      it('governed + healthy index → getHealth ok', async () => {
        const { manager } = createFakeDecisionManager();
        const handlers = await bootGoverned(manager);

        expect(handlers.getHealth!()).toEqual({
          ok: true,
          degraded: false,
          reason: null,
        });
        const status = handlers.getStatus() as Record<string, unknown>;
        expect(status.isGoverned).toBe(true);
        expect(status.isRuntimeDegraded).toBe(false);
      });

      it('NON-governed + index disabled → getHealth ok (index state never degrades a non-governed daemon)', async () => {
        const { manager } = createFakeDecisionManager({ enabled: false });
        // Default config (no deployment) is non-governed; boot is not A1-guarded.
        const { startDaemon } = await loadDaemon();
        const { createControlServer } = await import('./server.js');
        const result = await startDaemon('config.json', {
          decisionManager: asDecisionManager(manager),
        });
        expect(result.ok).toBe(true);
        const handlers = vi.mocked(createControlServer).mock.lastCall![1];

        expect(handlers.getHealth!()).toEqual({
          ok: true,
          degraded: false,
          reason: null,
        });
        const status = handlers.getStatus() as Record<string, unknown>;
        expect(status.isGoverned).toBe(false);
      });
    });

    it('leaves a parked run parked when no approval/rejection label is present', async () => {
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'awaiting-l2-review' }] },
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Pipeline should NOT have been called — run stays parked
      expect(mockRunPipeline).not.toHaveBeenCalled();
      // saveRunState should not have been called with phase reset
      const saveCallsWithReset = mockStateMgr.saveRunState.mock.calls.filter(
        (call) =>
          (call[0] as Record<string, unknown>)['issueNumber'] === 100 &&
          (call[0] as Record<string, unknown>)['phase'] === 'l2-gate',
      );
      expect(saveCallsWithReset).toHaveLength(0);
    });

    it('does not attempt to resume a parked run that is already active', async () => {
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'l2-approved' }] },
      });
      // Make a blocking run for issue 100 so it is in activeIssues
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // never resolves
      const blockingRequest = makeWorkRequest({ issueNumber: 100 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([blockingRequest]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // First poll: claims issue 100 via ready work (it's now active)
      await vi.advanceTimersByTimeAsync(30000);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(100);
      // Even with l2-approved, should not double-start since issue is already active
      // runPipeline was called once by processWorkRequest — not a second time by resumeParkedRuns
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('skips parked runs that are not at l2-gate', async () => {
      const parkedRun = makeParkedRun({ pausedAtPhase: 'detect' }); // unknown park phase
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'l2-approved' }] },
      });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Should not fetch labels or re-enter pipeline
      expect(mockOctokit.issues.get).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('handles GitHub API errors gracefully and continues poll cycle', async () => {
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockRejectedValue(new Error('GitHub API error'));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Should not crash — pipeline not called
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('parked runs are excluded from crash resumption', async () => {
      // A parked run: phase=paused with pausedAtPhase set
      const parkedRun = makeParkedRun();
      // findIncompleteRuns should NOT return parked runs (they're excluded by the new filter)
      mockStateMgr.findIncompleteRuns.mockResolvedValue([]);
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      // No labels → stays parked
      mockOctokit.issues.get.mockResolvedValue({ data: { labels: [] } });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      // findIncompleteRuns returned empty, so no crash resumption pipeline call
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });
  });

  describe('spawnTechLeadSession returns output not structuredData (#436)', () => {
    it('returns result.value.output (LLM text) so parseTechLeadOutput sees real proposals, not CLI wrapper', async () => {
      const proposalsJson = JSON.stringify({
        proposals: [],
        protocolTriggers: [],
      });
      const cliWrapper = { result: proposalsJson, cost_usd: 0.01 };
      mockSpawnSession.mockResolvedValue(
        ok({
          output: proposalsJson,
          structuredData: cliWrapper,
          cost: 0.01,
          pitfallMarkers: [],
          exitStatus: 'success',
        }),
      );

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // deps is first arg to createTechLeadScheduler
      const calls = mockCreateTechLeadScheduler.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const deps = calls[0]![0] as {
        spawnTechLeadSession: (digest: unknown) => Promise<string>;
      };

      const digest = {
        id: '00000000-0000-0000-0000-000000000000',
        trigger: 'scheduled',
        assembledAt: new Date().toISOString(),
      };
      const result = await deps.spawnTechLeadSession(digest);

      // Must be the raw LLM output, not the stringified CLI wrapper
      expect(result).toBe(proposalsJson);
      expect(result).not.toContain('cost_usd');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // gap #6 — detect-phase dispatch serialization acceptance gate (#779)
  // All tests named with "[detect]" so `-t "detect"` filter selects them.
  // RED until: detectInFlight Set, onDetectSettled param, gate-before-claim,
  //   per-run idempotent release, and FIFO defer for crash-resumption are wired.
  // ───────────────────────────────────────────────────────────────────────────
  describe('detect gate serialization (#779 gap6)', () => {
    /** Make a minimal incomplete-run fixture for crash-resumption tests. */
    function makeIncompleteRun(
      issueNumber: number,
      phase: string,
      owner = 'test-owner',
      repo = 'test-repo',
    ) {
      return {
        id: `run-${issueNumber}`,
        issueNumber,
        title: `Run #${issueNumber}`,
        phase,
        variant: 'feature',
        phaseCompletions: {},
        checkpoints: [] as unknown[],
        cost: 0,
        perRunBudget: 10,
        fixAttempts: [] as unknown[],
        errorHashes: {},
        repoOwner: owner,
        repoName: repo,
        startedAt: '2026-03-21T00:00:00Z',
        updatedAt: '2026-03-21T01:00:00Z',
      };
    }

    it('[detect] (a) second detect-run for same repo NOT claimed on same tick — gate is checked BEFORE claimWork (no stranded claim)', async () => {
      // With maxConcurrentRuns=2, the concurrency limit does not mask the detect gate.
      // Both requests are for the same repo → only the first should be claimed;
      // the second must be skipped (not claimed) so it retries on the next tick.
      // Without the gate the current code claims both → claimWork called twice → RED.
      const config = makeConfig({ maxConcurrentRuns: 2 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const requests = [
        makeWorkRequest({ issueNumber: 1001 }),
        makeWorkRequest({ issueNumber: 1002 }),
      ];
      mockDetector.detectReadyWork.mockResolvedValue(ok(requests));
      // Block so activeRuns stays at 1 (won't mask the gate via concurrency limit)
      mockRunPipeline.mockImplementation(() => new Promise(() => {}));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000); // first poll tick
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      // RED: without the gate, claimWork is called for both requests
      expect(mockDetector.claimWork).toHaveBeenCalledTimes(1);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(1001);
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(1002);
    });

    it('[detect] (b) gate clears on onDetectSettled signal — deferred run claimed on next tick only after settle', async () => {
      // Behavioral test: reqA claimed tick 1 (gate set), reqB NOT claimed tick 1 (gate holds),
      // onDetectSettled fires → gate cleared → reqB claimed tick 2 while reqA pipeline still running.
      // RED: (1) no gate → reqB claimed tick 1; (2) onDetectSettled not wired → arg[18] undefined.
      const config = makeConfig({ maxConcurrentRuns: 2 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const reqA = makeWorkRequest({ issueNumber: 1003 });
      const reqB = makeWorkRequest({ issueNumber: 1004 });
      mockDetector.detectReadyWork
        .mockResolvedValueOnce(ok([reqA, reqB])) // tick 1: both available
        .mockResolvedValueOnce(ok([reqB]))        // tick 2: reqB still available
        .mockResolvedValue(ok([]));

      let resolveRunA!: (v: { outcome: string }) => void;
      mockRunPipeline
        .mockImplementationOnce(() => new Promise((r) => { resolveRunA = r; })) // runA blocks
        .mockResolvedValue({ outcome: 'complete' }); // runB resolves when claimed

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000); // tick 1
      await vi.advanceTimersByTimeAsync(0);     // flush processWorkRequest setup

      // RED: without the gate, reqB is claimed on tick 1 too
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(1004);

      // phaseHandlerCalls[0][18] is onDetectSettled; RED if not wired
      const onDetectSettled = phaseHandlerCalls[0]?.[18] as (() => void) | undefined;
      expect(typeof onDetectSettled).toBe('function'); // RED: undefined

      // When wired: calling onDetectSettled should unblock reqB on next tick
      if (typeof onDetectSettled === 'function') {
        onDetectSettled(); // detect settled → gate cleared
        await vi.advanceTimersByTimeAsync(30000); // tick 2
        await vi.advanceTimersByTimeAsync(0);
        expect(mockDetector.claimWork).toHaveBeenCalledWith(1004); // reqB now claimable
        // runA pipeline still unresolved — early release confirmed by B being claimable
        expect(resolveRunA).toBeDefined(); // runA is still blocking
      }
    });

    it('[detect] (c) leak guard — run rejecting before detect still frees the gate via .finally backstop', async () => {
      // The pre-detect window (saveRunState → insertRun → token → readAgencyConfig →
      // createPhaseHandlers) can throw before detect ever runs. Without a .finally
      // backstop, detectInFlight leaks and the repo is permanently blocked.
      // Test: saveRunState rejects for reqA (pre-detect) → gate must clear → reqB
      // is NOT claimed on tick 1 (gate blocks it) → claimable on tick 2 after clear.
      // RED: without the gate, reqB is claimed on tick 1 too.
      const config = makeConfig({ maxConcurrentRuns: 2 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const reqA = makeWorkRequest({ issueNumber: 1004 });
      const reqB = makeWorkRequest({ issueNumber: 1005 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([reqA, reqB]));
      // saveRunState throws for reqA → processWorkRequest rejects before detect
      mockStateMgr.saveRunState.mockRejectedValueOnce(new Error('disk full'));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000); // tick 1
      await vi.advanceTimersByTimeAsync(0); // flush rejection + .finally

      // RED: without the gate, reqB is claimed on the same tick as reqA
      expect(mockDetector.claimWork).not.toHaveBeenCalledWith(1005);
    });

    it('[detect] (d) website variant (start phase "init") does NOT set the detect gate — detect run for same repo gets onDetectSettled', async () => {
      // Website runs start at 'init', not 'detect'. The gate must only apply to runs
      // whose entry phase is 'detect'. If website is incorrectly gated it leaks forever.
      // Use issue-based mock (not one-shot) so selectVariant call at the claim gate
      // doesn't consume the stub before processWorkRequest sees it.
      const config = makeConfig({ maxConcurrentRuns: 3 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // Issue-based variant selection: 1006=website, 1007=feature
      mockSelectVariant.mockImplementation((req: WorkRequest) =>
        req.issueNumber === 1006 ? 'website' : 'feature',
      );
      mockGetStartPhase.mockImplementation((variant: string) =>
        variant === 'website' ? 'init' : 'detect',
      );

      const requests = [
        makeWorkRequest({ issueNumber: 1006 }),
        makeWorkRequest({ issueNumber: 1007 }),
      ];
      mockDetector.detectReadyWork.mockResolvedValue(ok(requests));
      mockRunPipeline.mockImplementation(() => new Promise(() => {}));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Both requests claimed: website doesn't set gate so detect isn't blocked by it
      expect(mockDetector.claimWork).toHaveBeenCalledWith(1006);
      expect(mockDetector.claimWork).toHaveBeenCalledWith(1007);

      // detect run (1007): createPhaseHandlers call must have onDetectSettled (arg[18])
      // RED: arg[18] not wired yet
      const detectCall = phaseHandlerCalls.find(
        (call) => (call[6] as WorkRequest)?.issueNumber === 1007,
      );
      expect(typeof detectCall?.[18]).toBe('function'); // RED: undefined
    });

    it('[detect] (e) cross-run idempotent release — run-1 late .finally does NOT clear run-2 gate entry', async () => {
      // Per-run release closure is idempotent. Once run-1's detect settles
      // (onDetectSettled fires → gate deleted), the run-2 entry is a separate add.
      // A run-1 backstop .finally (fires after detect settled) must be a no-op,
      // not delete run-2's key.
      // RED: onDetectSettled not wired → phaseHandlerCalls[0][18] is undefined.
      const config = makeConfig({ maxConcurrentRuns: 2 });
      mockLoadConfig.mockResolvedValue(ok(config));

      const request = makeWorkRequest({ issueNumber: 1008 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      mockRunPipeline.mockImplementation(() => new Promise(() => {}));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // onDetectSettled must be a per-run function reference
      const onDetectSettledRun1 = phaseHandlerCalls[0]?.[18] as (() => void) | undefined;
      // RED: arg[18] not wired — undefined
      expect(typeof onDetectSettledRun1).toBe('function');
    });

    it('[detect] (f) crash-resume at detect phase is gated; post-detect crash-resume is NOT gated; reenterPipeline is NOT gated', async () => {
      // Crash-resumption path (findIncompleteRuns) must gate run.phase==='detect'.
      // A run resuming at 'implement' (already past detect) must NOT be gated.
      // Both pipelines should start: runB (implement) is NOT blocked even when runA (detect)
      // occupies the gate, because implement runs skip the detect gate entirely.
      // RED: createPhaseHandlers for crash-resumed detect run does not receive onDetectSettled.
      const runA = makeIncompleteRun(1009, 'detect');    // must be gated
      const runB = makeIncompleteRun(1010, 'implement'); // must NOT be gated (past detect)
      mockStateMgr.findIncompleteRuns.mockResolvedValue([runA, runB]);
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // both block

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0); // flush crash-resumption startup

      // runB (implement-phase) must start IMMEDIATELY — not blocked by runA's detect gate
      // Both runA and runB have runPipeline called (implement-phase doesn't wait on detect)
      expect(mockRunPipeline).toHaveBeenCalledTimes(2);

      // createPhaseHandlers for the detect run (run #1009) must have onDetectSettled wired
      const detectResumeCall = phaseHandlerCalls.find(
        (call) => (call[6] as { issueNumber: number })?.issueNumber === 1009,
      );
      // RED: crash-resume path doesn't pass onDetectSettled to createPhaseHandlers yet
      expect(typeof detectResumeCall?.[18]).toBe('function');

      // The implement-phase run (#1010) must NOT have onDetectSettled (it's post-detect)
      const implementResumeCall = phaseHandlerCalls.find(
        (call) => (call[6] as { issueNumber: number })?.issueNumber === 1010,
      );
      expect(implementResumeCall?.[18]).toBeUndefined();
    });

    it('[detect] (g) crash-resumed detect frees the gate EARLY via onDetectSettled — not only at whole-run finally', async () => {
      // Early release: the detect gate must clear when detect settles (detect.finally),
      // not when the whole multi-phase run completes. This keeps post-detect concurrency.
      // Requires onDetectSettled to be wired into the crash-resume createPhaseHandlers call.
      // RED: crash-resume path doesn't pass onDetectSettled (arg[18] is undefined).
      const run = makeIncompleteRun(1011, 'detect');
      mockStateMgr.findIncompleteRuns.mockResolvedValue([run]);
      mockRunPipeline.mockImplementation(() => new Promise(() => {})); // whole run never completes

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      const crashResumeCall = phaseHandlerCalls[0];
      // RED: arg[18] (onDetectSettled) not wired in crash-resume path
      expect(typeof crashResumeCall?.[18]).toBe('function');
    });

    it('[detect] (h) queue-defer invariant — two startup detect runs for same repo: second deferred, launched EXACTLY ONCE after first settles', async () => {
      // Crash-resumption is a one-shot startup pass — skip-and-drop is forbidden.
      // Two incomplete detect runs for the same repo → first runs immediately,
      // second is QUEUED/DEFERRED until the first detect settles (onDetectSettled fires),
      // then launched exactly once (not zero times, not twice — idempotent).
      // RED: current code (no defer) calls runPipeline for BOTH runs immediately → count=2.
      const run1 = makeIncompleteRun(1012, 'detect', 'test-owner', 'test-repo');
      const run2 = makeIncompleteRun(1013, 'detect', 'test-owner', 'test-repo'); // same repo
      mockStateMgr.findIncompleteRuns.mockResolvedValue([run1, run2]);

      let resolveRun1!: (v: { outcome: string }) => void;
      mockRunPipeline
        .mockImplementationOnce(
          () => new Promise((r) => { resolveRun1 = r; }),
        )
        .mockImplementation(() => Promise.resolve({ outcome: 'complete' }));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0); // flush startup

      // RED: without FIFO defer, runPipeline is called for both runs immediately (count=2)
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);

      // onDetectSettled for run1 must be wired — RED if undefined
      const onDetectSettledRun1 = phaseHandlerCalls[0]?.[18] as (() => void) | undefined;
      expect(typeof onDetectSettledRun1).toBe('function'); // RED: not wired

      if (typeof onDetectSettledRun1 === 'function') {
        // Settle run-1's detect → gate cleared → run-2 launched
        onDetectSettledRun1();
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRunPipeline).toHaveBeenCalledTimes(2); // run-2 launched exactly once

        // Idempotency: calling onDetectSettled AGAIN (late .finally backstop simulation)
        // must NOT launch run-2 a second time
        onDetectSettledRun1();
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRunPipeline).toHaveBeenCalledTimes(2); // still exactly 2 — no double-launch

        // Resolving run-1's whole pipeline also must not re-launch run-2
        resolveRun1({ outcome: 'complete' });
        await vi.advanceTimersByTimeAsync(0);
        expect(mockRunPipeline).toHaveBeenCalledTimes(2); // still 2
      }
    });
  });
});
