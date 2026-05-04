// src/control-plane/daemon.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '../lib/result.js';
import type { Config } from '../config.js';
import type { WorkRequest } from '../types.js';

// --- Hoisted mocks (vi.mock factories are hoisted above all other code) ---

const {
  mockStateMgr, mockCostTracker, mockRemoteControl, mockDetector,
  mockServer, mockServerStart, mockRunPipeline, mockNotify,
  mockRunWriter, mockConfigReader, mockLoadConfig, mockSelectVariant, phaseHandlerCalls, mockCreateReviewScheduler,
  mockCreatePOAgent, mockCreateTechLeadScheduler, mockCreateCoordinator,
  knowledgeStoreCtorArgs, mockOctokit, mockSpawnSession, mockValidatePromptContracts,
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
  mockServer: { close: vi.fn((cb?: () => void) => { if (cb) cb(); }) },
  mockServerStart: vi.fn(),
  mockRunPipeline: vi.fn(),
  mockNotify: vi.fn(),
  mockRunWriter: { upsertRun: vi.fn() },
  mockConfigReader: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getGlobalConfig: vi.fn().mockReturnValue(null),
    getRepoConfig: vi.fn().mockReturnValue(null),
  },
  mockLoadConfig: vi.fn(),
  mockSelectVariant: vi.fn(),
  phaseHandlerCalls: [] as unknown[][],
  mockCreateReviewScheduler: vi.fn().mockReturnValue({ start: () => () => {}, getStatus: () => ({}) }),
  mockCreatePOAgent: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnValue(vi.fn()),
    submitIdea: vi.fn().mockResolvedValue({ id: 'idea-1', submittedBy: 'operator', description: 'test', status: 'pending', proposalId: null, createdAt: '2026-03-23T00:00:00Z' }),
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
      get: vi.fn().mockResolvedValue({ data: { labels: [] } }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
    },
  },
  mockSpawnSession: vi.fn(),
  mockValidatePromptContracts: vi.fn(),
}));

// --- Module mocks (use classes for constructors to work with `new`) ---

vi.mock('./state.js', () => {
  return { StateManager: class { initialize = mockStateMgr.initialize; saveRunState = mockStateMgr.saveRunState; findIncompleteRuns = mockStateMgr.findIncompleteRuns; findParkedRuns = mockStateMgr.findParkedRuns; } };
});
vi.mock('../session-runtime/cost.js', () => {
  return { CostTracker: class { getDailyCost = mockCostTracker.getDailyCost; maybeResetDaily = mockCostTracker.maybeResetDaily; } };
});
vi.mock('../session-runtime/runtime.js', () => {
  return {
    SessionRuntime: class { spawnSession = mockSpawnSession; },
    preloadPromptCache: async () => 0,
  };
});
vi.mock('../knowledge/gotcha-store.js', () => {
  return { GotchaStore: class {} };
});
vi.mock('../knowledge/knowledge-store.js', () => {
  return { KnowledgeStore: class { constructor(...args: unknown[]) { knowledgeStoreCtorArgs.length = 0; knowledgeStoreCtorArgs.push(...args); } } };
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
  return { RemoteControlManager: class { start = mockRemoteControl.start; stop = mockRemoteControl.stop; restart = mockRemoteControl.restart; getState = mockRemoteControl.getState; } };
});
vi.mock('./work-detection.js', () => ({
  createWorkDetector: () => mockDetector,
}));
vi.mock('./server.js', () => ({
  createControlServer: vi.fn((_port: number, _handlers: unknown) => ({
    server: mockServer,
    start: mockServerStart,
  })),
}));
vi.mock('./phases.js', () => ({
  createPhaseHandlers: (...args: unknown[]) => { phaseHandlerCalls.push(args); return {}; },
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
  getStartPhase: () => 'detect',
}));
vi.mock('./variants.js', () => ({
  selectVariant: (...args: unknown[]) => mockSelectVariant(...args),
}));
vi.mock('./notify.js', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));
vi.mock('../supabase/client.js', () => ({
  getSupabaseClient: () => null,
}));
vi.mock('../supabase/config-reader.js', () => {
  return { SupabaseConfigReader: class { start = mockConfigReader.start; stop = mockConfigReader.stop; getGlobalConfig = mockConfigReader.getGlobalConfig; getRepoConfig = mockConfigReader.getRepoConfig; } };
});
vi.mock('../supabase/run-writer.js', () => {
  return {
    SupabaseRunWriter: class { upsertRun = mockRunWriter.upsertRun; },
    toDbOutcome: (o: string) => o,
  };
});
vi.mock('@octokit/rest', () => {
  return { Octokit: class { issues = mockOctokit.issues; } };
});
vi.mock('../config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));
vi.mock('../coordination/review-scheduler.js', () => ({
  createReviewScheduler: (...args: unknown[]) => mockCreateReviewScheduler(...args),
}));
vi.mock('../coordination/po-agent.js', () => ({
  createPOAgent: (...args: unknown[]) => mockCreatePOAgent(...args),
}));
vi.mock('../coordination/tech-lead-scheduler.js', () => ({
  createTechLeadScheduler: (...args: unknown[]) => mockCreateTechLeadScheduler(...args),
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
  TechProposalStore: class { init = vi.fn().mockResolvedValue(undefined); loadActiveProposals = vi.fn().mockResolvedValue([]); loadRejectedProposals = vi.fn().mockResolvedValue([]); loadAllProposals = vi.fn().mockResolvedValue([]); findDuplicate = vi.fn().mockResolvedValue(undefined); saveProposal = vi.fn().mockResolvedValue(undefined); },
}));
vi.mock('../coordination/tech-lead/signal-digest.js', () => ({
  assembleSignalDigest: vi.fn().mockResolvedValue({ id: 'digest-1', trigger: 'scheduled', reviewFindings: [], runOutcomes: [], driftIndicators: [], deferredWork: [], testHealth: [], dependencyRisks: [], activeProposals: [], priorRejections: [], missingSources: [], assembledAt: '2026-03-23T00:00:00Z' }),
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
  dailyBudget: 50,
  perRunBudget: 10,
  adapter: 'cli' as const,
  branches: { staging: 'staging', production: 'main' },
  webhooks: [],
  validation: {
    gate1Commands: [],
    maxFixCycles: 3,
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
    useCoordinator: false, tickInterval: 5000,
    maxAgents: 10, reviewerInterval: 3600000, poInterval: 3600000,
    poIdeaDebounce: 300000, poFindingDailyCap: 5,
    plannerTimeout: 60000, maxAttemptsPerIssue: 3, diskSpaceThreshold: 2_000_000_000,
    gcInterval: 600000, conflictFileThreshold: 3, conflictLineThreshold: 100,
    mergeDependencyTimeout: 1800000, mergeValidationTimeout: 600000,
    mergePollInterval: 5000, mergePollMaxInterval: 60000,
    techLeadInterval: 7200000, techLeadEventDebounce: 300000,
    techLeadProposalExpiryMs: 604800000, techLeadLookbackWindowMs: 172800000,
    techLeadMaxEntriesPerSection: 50,
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

// daemon.ts has module-level state (dailyRunCount, dailyRunCountResetDate),
// so we reset modules before each import to ensure a fresh state per test.
const loadDaemon = () => {
  vi.resetModules();
  return import('./daemon.js');
};

describe('daemon', () => {
  const signalHandlers: Record<string, (() => Promise<void>)> = {};

  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure GITHUB_TOKEN is set for all tests (validated at daemon startup)
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    // Capture signal handlers — cast to any to avoid process.on overload complexity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
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
    mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
    mockServerStart.mockResolvedValue(ok(undefined));
    mockNotify.mockResolvedValue(undefined);
    mockStateMgr.initialize.mockResolvedValue(undefined);
    mockStateMgr.saveRunState.mockResolvedValue(undefined);
    mockStateMgr.findIncompleteRuns.mockResolvedValue([]);
    mockStateMgr.findParkedRuns.mockResolvedValue([]);
    mockOctokit.issues.get.mockResolvedValue({ data: { labels: [] } });
    mockOctokit.issues.removeLabel.mockResolvedValue(undefined);
    mockRemoteControl.stop.mockResolvedValue(undefined);
    mockCostTracker.getDailyCost.mockReturnValue(0);
    mockRunWriter.upsertRun.mockResolvedValue(undefined);
    mockCreateReviewScheduler.mockReturnValue({ start: () => () => {}, getStatus: () => ({}) });
    mockCreatePOAgent.mockReturnValue({
      start: vi.fn().mockReturnValue(vi.fn()),
      submitIdea: vi.fn().mockResolvedValue({ id: 'idea-1', submittedBy: 'operator', description: 'test', status: 'pending', proposalId: null, createdAt: '2026-03-23T00:00:00Z' }),
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
      mockDetector.detectReadyWork, mockDetector.detectBugFixWork, mockDetector.detectFeaturePipelineWork, mockDetector.claimWork, mockDetector.claimBugFixWork, mockDetector.claimFeaturePipelineWork, mockDetector.markStuck,
      mockRunPipeline, mockNotify, mockServerStart, mockLoadConfig,
      mockStateMgr.initialize, mockStateMgr.saveRunState, mockStateMgr.findIncompleteRuns, mockStateMgr.findParkedRuns,
      mockOctokit.issues.get, mockOctokit.issues.removeLabel,
      mockServer.close, mockRemoteControl.start, mockRemoteControl.stop,
      mockCostTracker.getDailyCost, mockCostTracker.maybeResetDaily,
      mockRunWriter.upsertRun,
      mockConfigReader.start, mockConfigReader.stop,
      mockConfigReader.getGlobalConfig, mockConfigReader.getRepoConfig,
      mockSelectVariant,
      mockCreateReviewScheduler,
      mockCreatePOAgent,
      mockCreateTechLeadScheduler,
      mockCreateCoordinator,
      mockSpawnSession,
      mockValidatePromptContracts,
    ]) {
      mock.mockClear();
    }
    phaseHandlerCalls.length = 0;
    for (const key in signalHandlers) delete signalHandlers[key];
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

    it('returns ok and starts control server in legacy mode', async () => {
      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(true);
      expect(mockServerStart).toHaveBeenCalled();
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

    it('returns error in legacy mode when config.repo is missing and no supabase', async () => {
      mockLoadConfig.mockResolvedValue(ok(makeConfig({ repo: undefined })));

      const { startDaemon } = await loadDaemon();
      const result = await startDaemon('config.json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('No SUPABASE_URL');
      }
      expect(mockRemoteControl.stop).toHaveBeenCalled();
    });

    it('registers SIGTERM and SIGINT shutdown handlers', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(signalHandlers['SIGTERM']).toBeDefined();
      expect(signalHandlers['SIGINT']).toBeDefined();
    });

    it('starts RemoteControlManager', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockRemoteControl.start).toHaveBeenCalled();
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
      expect(callArgs[0]).toMatchObject({ issueNumber: 55, phase: 'implement' });
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
      expect(workRequest.specRefs).toEqual(['FUNC-AC-PIPELINE', 'ARCH-AC-CONTROL-PLANE']);
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
      mockRunPipeline.mockImplementationOnce(() => new Promise((r) => { resolveResume = r; }));

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
      const config = makeConfig({ maxConsecutiveStuck: 2, webhooks: ['https://hooks.example.com/test'] });
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
      const run2 = { ...run1, id: 'run-stuck-2', issueNumber: 81, title: 'Stuck resumed run 2' };
      mockStateMgr.findIncompleteRuns.mockResolvedValue([run1, run2]);
      mockRunPipeline.mockResolvedValue({ outcome: 'stuck', error: 'test failure' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(true);
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(2);
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
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(1);
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

    it('claims and processes work when detected', async () => {
      const request = makeWorkRequest();
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);

      expect(mockDetector.claimWork).toHaveBeenCalledWith(42);
      // Flush microtask queue so processWorkRequest's .then/.catch/.finally resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(mockStateMgr.saveRunState).toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalled();
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
      mockDetector.detectReadyWork.mockResolvedValue(err(new Error('API rate limited')));

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
      const config = makeConfig({ pollIntervalMs: 1000, maxConcurrentRuns: 10 });
      mockLoadConfig.mockResolvedValue(ok(config));

      let resolveDetect!: (value: Awaited<ReturnType<typeof mockDetector.detectReadyWork>>) => void;
      const pendingDetect = new Promise<Awaited<ReturnType<typeof mockDetector.detectReadyWork>>>((resolve) => {
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
      const requests = [makeWorkRequest({ issueNumber: 1 }), makeWorkRequest({ issueNumber: 2 })];
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
      mockRunPipeline.mockResolvedValue({ outcome: 'stuck', error: 'budget exceeded' });

      const request = makeWorkRequest({ issueNumber: 7 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));

      const config = makeConfig({ webhooks: ['https://hooks.example.com/test'] });
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
      const config = makeConfig({ maxConsecutiveStuck: 2, webhooks: ['https://hooks.example.com/test'] });
      mockLoadConfig.mockResolvedValue(ok(config));
      mockRunPipeline.mockResolvedValue({ outcome: 'stuck', error: 'test failure' });

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
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(false);

      // Second poll: another stuck run → auto-pause
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(true);
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(2);
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
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'stuck', error: 'fail' });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(1);

      // Second run: complete → resets count
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'complete' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(0);
    });

    it('resets stuck count and pauses daemon on paused outcome (#109, #293)', async () => {
      const config = makeConfig({ maxConsecutiveStuck: 3 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'stuck', error: 'fail' });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(1);

      // Second run: paused (budget exceeded) → resets count AND pauses daemon
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'paused' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(0);
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(true);

      // Daemon is paused — no new work will be processed, so stuck count stays 0
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(0);
    });

    it('auto-pauses daemon on budget-exceeded paused outcome (#293)', async () => {
      const config = makeConfig({ webhooks: ['https://hooks.example.com/test'] });
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

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(true);
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

      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(false);
      handlers.pause();
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(true);
      handlers.resume();
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(false);
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

      expect((handlers.getStatus() as Record<string, unknown>)['dailyRunCount']).toBe(0);

      // Trigger a poll so one run is processed
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect((handlers.getStatus() as Record<string, unknown>)['dailyRunCount']).toBe(1);
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
      mockDetector.claimBugFixWork.mockResolvedValue(err(new Error('already claimed')));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimBugFixWork).toHaveBeenCalledWith(50);
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('handles detectBugFixWork returning an error gracefully', async () => {
      mockDetector.detectBugFixWork.mockResolvedValue(err(new Error('API error')));

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

      expect(mockDetector.claimFeaturePipelineWork).toHaveBeenCalledWith(60, 'l2-brainstorm');
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
      mockDetector.claimFeaturePipelineWork.mockResolvedValue(err(new Error('already claimed')));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDetector.claimFeaturePipelineWork).toHaveBeenCalledWith(60, 'l2-brainstorm');
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    it('handles detectFeaturePipelineWork returning an error gracefully', async () => {
      mockDetector.detectFeaturePipelineWork.mockResolvedValue(err(new Error('API error')));

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
      expect(agent.submitIdea).toHaveBeenCalledWith('operator', 'Build dark mode');
      expect(result.id).toBe('idea-1');
    });
  });

  describe('review scheduler config (#334)', () => {
    it('passes coordination.reviewerInterval to createReviewScheduler (#356)', async () => {
      const config = makeConfig({
        coordination: {
          ...makeConfig().coordination,
          reviewerInterval: 7200000,  // 2 hours — non-default
        },
        validation: {
          ...makeConfig().validation,
          proactiveThrottleThreshold: 0.75,  // non-default
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
          reviewerInterval: 5400000,  // 90 minutes
        },
        validation: {
          ...makeConfig().validation,
          proactiveIntervalMs: 900000,  // 15 minutes — must be ignored
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
      mockSpawnSession.mockResolvedValueOnce(ok({
        output: 'review output',
        structuredData: {
          category: 'correctness',
          findings: [
            { title: 'Bug A', severity: 'important', location: 'foo.ts:1', description: 'd', evidence: 'e' },
            { title: 'Bug B', severity: 'critical', location: 'bar.ts:2', description: 'd', evidence: 'e' },
          ],
          scannedFiles: 15,
          candidatesFound: 8,
          candidatesDropped: 6,
          summary: 'Found 2 verified issues',
        },
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'success',
      }));

      const result = await deps.spawnReviewSession('correctness', 5);
      expect(result.findingsCount).toBe(2);
      expect(result.issuesCreated).toBe(0);
    });

    it('returns findingsCount 0 when structuredData has no findings array', async () => {
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      const [deps] = mockCreateReviewScheduler.mock.calls[0]!;

      mockSpawnSession.mockResolvedValueOnce(ok({
        output: 'review output',
        structuredData: null,
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'success',
      }));

      const result = await deps.spawnReviewSession('security', 5);
      expect(result.findingsCount).toBe(0);
      expect(result.issuesCreated).toBe(0);
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
        coordination: { ...makeConfig().coordination, useCoordinator: true, tickInterval: 3000, maxAgents: 5, diskSpaceThreshold: 1_000_000_000 },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      const [, coordConfig] = mockCreateCoordinator.mock.calls[0]!;
      expect(coordConfig).toMatchObject({ tickIntervalMs: 3000, maxAgents: 5, diskSpaceThreshold: 1_000_000_000 });
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

    it('does NOT start legacy poll loop when coordinator is enabled', async () => {
      const config = makeConfig({
        coordination: { ...makeConfig().coordination, useCoordinator: true },
      });
      mockLoadConfig.mockResolvedValue(ok(config));
      const request = makeWorkRequest({ issueNumber: 42 });
      mockDetector.detectReadyWork.mockResolvedValue(ok([request]));
      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockDetector.detectReadyWork).not.toHaveBeenCalled();
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
      mockCreateCoordinator.mockReturnValue({ start: vi.fn().mockReturnValue(mockStopCoordinator) });
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
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(0);
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
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(false);
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
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'stuck', error: 'fail' });
      const request1 = makeWorkRequest({ issueNumber: 1 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request1]));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      const { createControlServer } = await import('./server.js');
      const handlers = vi.mocked(createControlServer).mock.lastCall![1];
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(1);

      // Second run: parked — should NOT change consecutiveStuckCount
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'parked' });
      const request2 = makeWorkRequest({ issueNumber: 2 });
      mockDetector.detectReadyWork.mockResolvedValueOnce(ok([request2]));

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Parked is a no-op — stuck count stays at 1
      expect((handlers.getStatus() as Record<string, unknown>)['consecutiveStuckCount']).toBe(1);
      expect((handlers.getStatus() as Record<string, unknown>)['paused']).toBe(false);
    });
  });

  describe('retry backoff', () => {
    it('skips issue in backoff window after it went stuck', async () => {
      const config = makeConfig({ retryBackoffBaseMs: 60_000, retryBackoffMaxMs: 1_800_000 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'stuck', error: 'fail' });
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
      const config = makeConfig({ retryBackoffBaseMs: 1_000, retryBackoffMaxMs: 5_000 });
      mockLoadConfig.mockResolvedValue(ok(config));

      // First run: stuck
      mockRunPipeline.mockResolvedValueOnce({ outcome: 'stuck', error: 'fail' });
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
      phaseCompletions: { detect: true, classify: true, 'l1-design': true, 'l2-design': true },
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
        data: { labels: [{ name: 'l2-approved' }, { name: 'awaiting-l2-review' }] },
      });
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // Trigger one poll cycle
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      // Should have fetched issue labels
      expect(mockOctokit.issues.get).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'test-owner', repo: 'test-repo', issue_number: 100 }),
      );
      // Should have removed awaiting-l2-review label (best-effort)
      expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'awaiting-l2-review', issue_number: 100 }),
      );
      // Should have reset state and re-entered pipeline
      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 100, phase: 'l2-gate', pausedAtPhase: undefined }),
      );
      expect(mockRunPipeline).toHaveBeenCalled();
    });

    it('resumes a parked run when l2-rejected label is present', async () => {
      const parkedRun = makeParkedRun();
      mockStateMgr.findParkedRuns.mockResolvedValue([parkedRun]);
      mockOctokit.issues.get.mockResolvedValue({
        data: { labels: [{ name: 'l2-rejected' }] },
      });
      mockRunPipeline.mockResolvedValue({ outcome: 'complete' });

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockStateMgr.saveRunState).toHaveBeenCalledWith(
        expect.objectContaining({ issueNumber: 100, phase: 'l2-gate', pausedAtPhase: undefined }),
      );
      expect(mockRunPipeline).toHaveBeenCalled();
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
        (call) => (call[0] as Record<string, unknown>)['issueNumber'] === 100 && (call[0] as Record<string, unknown>)['phase'] === 'l2-gate',
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
      const proposalsJson = JSON.stringify({ proposals: [], protocolTriggers: [] });
      const cliWrapper = { result: proposalsJson, cost_usd: 0.01 };
      mockSpawnSession.mockResolvedValue(ok({
        output: proposalsJson,
        structuredData: cliWrapper,
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'success',
      }));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      // deps is first arg to createTechLeadScheduler
      const calls = mockCreateTechLeadScheduler.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const deps = calls[0]![0] as { spawnTechLeadSession: (digest: unknown) => Promise<string> };

      const digest = { id: '00000000-0000-0000-0000-000000000000', trigger: 'scheduled', assembledAt: new Date().toISOString() };
      const result = await deps.spawnTechLeadSession(digest);

      // Must be the raw LLM output, not the stringified CLI wrapper
      expect(result).toBe(proposalsJson);
      expect(result).not.toContain('cost_usd');
    });
  });
});
