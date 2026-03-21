// src/control-plane/daemon.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '../lib/result.js';
import type { Config } from '../config.js';
import type { WorkRequest } from '../types.js';

// --- Hoisted mocks (vi.mock factories are hoisted above all other code) ---

const {
  mockStateMgr, mockCostTracker, mockRemoteControl, mockDetector,
  mockServer, mockServerStart, mockRunPipeline, mockNotify,
  mockRunWriter, mockConfigReader, mockLoadConfig,
} = vi.hoisted(() => ({
  mockStateMgr: {
    initialize: vi.fn().mockResolvedValue(undefined),
    saveRunState: vi.fn().mockResolvedValue(undefined),
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
    claimWork: vi.fn(),
    markStuck: vi.fn(),
  },
  mockServer: { close: vi.fn() },
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
}));

// --- Module mocks (use classes for constructors to work with `new`) ---

vi.mock('./state.js', () => {
  return { StateManager: class { initialize = mockStateMgr.initialize; saveRunState = mockStateMgr.saveRunState; } };
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
  createPhaseHandlers: () => ({}),
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
  selectVariant: () => 'feature',
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

// --- Helpers ---

const makeConfig = (overrides?: Partial<Config>): Config => ({
  controlPort: 3847,
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
  },
  diagnosis: { confidenceThreshold: 0.7 },
  warmup: { threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 },
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
    // Capture signal handlers — cast to any to avoid process.on overload complexity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => Promise<void>) => {
      signalHandlers[event] = handler;
      return process;
    }) as any);
    // Reset all mock state
    mockLoadConfig.mockResolvedValue(ok(makeConfig()));
    mockDetector.detectReadyWork.mockResolvedValue(ok([]));
    mockDetector.claimWork.mockResolvedValue(ok(undefined));
    mockDetector.markStuck.mockResolvedValue(ok(undefined));
    mockRunPipeline.mockResolvedValue({ outcome: 'complete' });
    mockServerStart.mockResolvedValue(ok(undefined));
    mockNotify.mockResolvedValue(undefined);
    mockStateMgr.initialize.mockResolvedValue(undefined);
    mockStateMgr.saveRunState.mockResolvedValue(undefined);
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
      mockDetector.detectReadyWork, mockDetector.claimWork, mockDetector.markStuck,
      mockRunPipeline, mockNotify, mockServerStart, mockLoadConfig,
      mockStateMgr.initialize, mockStateMgr.saveRunState,
      mockServer.close, mockRemoteControl.start, mockRemoteControl.stop,
      mockCostTracker.getDailyCost, mockCostTracker.maybeResetDaily,
      mockRunWriter.upsertRun,
      mockConfigReader.start, mockConfigReader.stop,
      mockConfigReader.getGlobalConfig, mockConfigReader.getRepoConfig,
    ]) {
      mock.mockClear();
    }
    for (const key in signalHandlers) delete signalHandlers[key];
  });

  describe('startDaemon', () => {
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
});
