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
} = vi.hoisted(() => ({
  mockStateMgr: {
    initialize: vi.fn().mockResolvedValue(undefined),
    saveRunState: vi.fn().mockResolvedValue(undefined),
    findIncompleteRuns: vi.fn().mockResolvedValue([]),
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
}));

// --- Module mocks (use classes for constructors to work with `new`) ---

vi.mock('./state.js', () => {
  return { StateManager: class { initialize = mockStateMgr.initialize; saveRunState = mockStateMgr.saveRunState; findIncompleteRuns = mockStateMgr.findIncompleteRuns; } };
});
vi.mock('../session-runtime/cost.js', () => {
  return { CostTracker: class { getDailyCost = mockCostTracker.getDailyCost; maybeResetDaily = mockCostTracker.maybeResetDaily; } };
});
vi.mock('../session-runtime/runtime.js', () => {
  return { SessionRuntime: class {} };
});
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
  return { Octokit: class {} };
});
vi.mock('../config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));
vi.mock('../coordination/review-scheduler.js', () => ({
  createReviewScheduler: (...args: unknown[]) => mockCreateReviewScheduler(...args),
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
    maxAgents: 10, reviewerInterval: 3600000, poInterval: 3600000,
    plannerTimeout: 60000, maxAttemptsPerIssue: 3, diskSpaceThreshold: 2_000_000_000,
    gcInterval: 600000, conflictFileThreshold: 3, conflictLineThreshold: 100,
    mergeDependencyTimeout: 1800000, mergeValidationTimeout: 600000,
    mergePollInterval: 5000, mergePollMaxInterval: 60000,
  },
  diagnosis: { confidenceThreshold: 0.7 },
  warmup: { threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 },
  maxConsecutiveStuck: 3,
  gracePeriodMs: 100,
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

// Note: dynamic import is cached after first call — all tests share the same
// module instance. This works because mocks are reset in beforeEach/afterEach.
// If daemon.ts ever introduces module-level state, use vi.resetModules().
const loadDaemon = () => import('./daemon.js');

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
    mockRemoteControl.stop.mockResolvedValue(undefined);
    mockCostTracker.getDailyCost.mockReturnValue(0);
    mockRunWriter.upsertRun.mockResolvedValue(undefined);
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
      mockStateMgr.initialize, mockStateMgr.saveRunState, mockStateMgr.findIncompleteRuns,
      mockServer.close, mockRemoteControl.start, mockRemoteControl.stop,
      mockCostTracker.getDailyCost, mockCostTracker.maybeResetDaily,
      mockRunWriter.upsertRun,
      mockConfigReader.start, mockConfigReader.stop,
      mockConfigReader.getGlobalConfig, mockConfigReader.getRepoConfig,
      mockSelectVariant,
      mockCreateReviewScheduler,
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

  describe('review scheduler config (#334)', () => {
    it('passes config.validation.proactiveIntervalMs and proactiveThrottleThreshold to createReviewScheduler', async () => {
      const config = makeConfig({
        validation: {
          ...makeConfig().validation,
          proactiveIntervalMs: 900000,       // 15 minutes — non-default
          proactiveThrottleThreshold: 0.75,  // non-default
        },
      });
      mockLoadConfig.mockResolvedValue(ok(config));

      const { startDaemon } = await loadDaemon();
      await startDaemon('config.json');

      expect(mockCreateReviewScheduler).toHaveBeenCalledTimes(1);
      const [, schedulerConfig] = mockCreateReviewScheduler.mock.calls[0]!;
      expect(schedulerConfig.intervalMs).toBe(900000);
      expect(schedulerConfig.signalRatioThreshold).toBe(0.75);
    });
  });
});
