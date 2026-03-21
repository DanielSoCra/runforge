// src/control-plane/phases.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

// Mock all external dependencies before importing the module under test
vi.mock('../lib/git.js', () => ({
  git: vi.fn(),
}));

vi.mock('../validation/gates.js', () => ({
  createGate1: vi.fn(),
}));

vi.mock('../validation/review.js', () => ({
  runReview: vi.fn(),
}));

vi.mock('./reporter.js', () => ({
  formatReport: vi.fn(() => 'mock report'),
  postReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));

vi.mock('./notify.js', () => ({
  notify: vi.fn(async () => {}),
}));

vi.mock('./results.js', () => ({
  appendResult: vi.fn(async () => {}),
}));

vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn(() => ({
    completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
  })),
}));

// Import after mocks are set up
import { createPhaseHandlers, acquireDetectLock, releaseDetectLock, isDetectLocked } from './phases.js';
import { git } from '../lib/git.js';
import { createGate1 } from '../validation/gates.js';
import { runReview } from '../validation/review.js';
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import { createWorkDetector } from './work-detection.js';

const mockGit = vi.mocked(git);
const mockCreateGate1 = vi.mocked(createGate1);
const mockRunReview = vi.mocked(runReview);
const mockFormatReport = vi.mocked(formatReport);
const mockPostReport = vi.mocked(postReport);
const mockNotify = vi.mocked(notify);
const mockAppendResult = vi.mocked(appendResult);
const mockCreateWorkDetector = vi.mocked(createWorkDetector);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    controlPort: 3847,
    pollIntervalMs: 30000,
    maxConcurrentRuns: 1,
    dailyBudget: 50,
    perRunBudget: 10,
    adapter: 'cli',
    branches: { staging: 'staging', production: 'main' },
    webhooks: ['https://example.com/hook'],
    validation: {
      gate1Commands: ['vitest run'],
      maxFixCycles: 3,
      staticAnalysis: { maxComplexity: 15, maxFunctionLength: 50, maxFileSize: 500 },
    },
    diagnosis: { confidenceThreshold: 0.7 },
    warmup: { threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 },
    gracePeriodMs: 30000,
    activePlugins: [],
    ...overrides,
  } as Config;
}

function makeRun(): RunState {
  return {
    id: 'test-run',
    issueNumber: 42,
    title: 'Test issue',
    phase: 'detect',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true },
    checkpoints: [],
    cost: 1.5,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
  };
}

function makeWorkRequest(): WorkRequest {
  return {
    issueNumber: 42,
    title: 'Test issue',
    body: 'Fix something',
    labels: ['ready'],
    specRefs: [],
  };
}

const mockOctokit = {} as any;

function createHandlers(configOverrides: Partial<Config> = {}) {
  const config = makeConfig(configOverrides);
  const mockRuntime = {} as any;
  const mockCoordinator = { implement: vi.fn() } as any;
  return {
    handlers: createPhaseHandlers(
      config, 'owner', 'repo', mockRuntime, mockCoordinator,
      mockOctokit, makeWorkRequest(), '/tmp/state', undefined, undefined,
    ),
    coordinator: mockCoordinator,
    config,
  };
}

describe('detect lock', () => {
  afterEach(() => {
    releaseDetectLock();
  });

  it('acquires the lock when free', () => {
    expect(isDetectLocked()).toBe(false);
    expect(acquireDetectLock()).toBe(true);
    expect(isDetectLocked()).toBe(true);
  });

  it('rejects second acquisition while locked', () => {
    acquireDetectLock();
    expect(acquireDetectLock()).toBe(false);
  });

  it('allows re-acquisition after release', () => {
    acquireDetectLock();
    releaseDetectLock();
    expect(acquireDetectLock()).toBe(true);
  });
});

describe('createPhaseHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseDetectLock();
    // Reset completeWork mock on detector
    mockCreateWorkDetector.mockReturnValue({
      completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
      detectReadyWork: vi.fn(),
      claimWork: vi.fn(),
      markStuck: vi.fn(),
    } as any);
  });

  afterEach(() => {
    releaseDetectLock();
  });

  describe('detect', () => {
    it('creates a new feature branch from staging', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout -b feature/42
      const { handlers } = createHandlers();
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('success');
      expect(mockGit).toHaveBeenCalledWith(['checkout', 'staging']);
      expect(mockGit).toHaveBeenCalledWith(['checkout', '-b', 'feature/42', 'staging']);
    });

    it('checks out existing branch when creation fails', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('branch exists') }); // checkout -b fails
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout feature/42
      const { handlers } = createHandlers();
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('success');
      expect(mockGit).toHaveBeenCalledWith(['checkout', 'feature/42']);
    });

    it('returns failure when fallback checkout also fails', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('branch exists') }); // checkout -b fails
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('fatal') }); // checkout also fails
      const { handlers } = createHandlers();
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('failure');
    });

    it('returns failure when detect lock is held by another run', async () => {
      acquireDetectLock();
      const { handlers } = createHandlers();
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('failure');
      // git should never have been called
      expect(mockGit).not.toHaveBeenCalled();
    });

    it('releases detect lock after successful detect', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' });
      mockGit.mockResolvedValueOnce({ ok: true, value: '' });
      const { handlers } = createHandlers();
      expect(isDetectLocked()).toBe(false);
      await handlers.detect!(makeRun());
      expect(isDetectLocked()).toBe(false);
    });

    it('releases detect lock even when git fails', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('branch exists') });
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('fatal') });
      const { handlers } = createHandlers();
      await handlers.detect!(makeRun());
      // Lock must be released even on failure
      expect(isDetectLocked()).toBe(false);
    });
  });

  describe('classify', () => {
    it('returns success:simple (MVP stub)', async () => {
      const { handlers } = createHandlers();
      const result = await handlers.classify!(makeRun());
      expect(result).toBe('success:simple');
    });
  });

  describe('implement', () => {
    it('returns success and accumulates cost on successful implementation', async () => {
      const { handlers, coordinator } = createHandlers();
      coordinator.implement.mockResolvedValue({
        ok: true,
        value: { success: true, totalCost: 2.5 },
      });
      const run = makeRun();
      const result = await handlers.implement!(run);
      expect(result).toBe('success');
      expect(run.cost).toBe(4.0); // 1.5 + 2.5
    });

    it('returns failure when coordinator returns error result', async () => {
      const { handlers, coordinator } = createHandlers();
      coordinator.implement.mockResolvedValue({
        ok: false,
        error: new Error('spawn failed'),
      });
      const result = await handlers.implement!(makeRun());
      expect(result).toBe('failure');
    });

    it('returns failure when implementation reports non-success', async () => {
      const { handlers, coordinator } = createHandlers();
      coordinator.implement.mockResolvedValue({
        ok: true,
        value: { success: false, error: 'tests failed' },
      });
      const result = await handlers.implement!(makeRun());
      expect(result).toBe('failure');
    });
  });

  describe('review', () => {
    it('returns success when all gates pass', async () => {
      const mockGate = { type: 'deterministic', execute: vi.fn() };
      mockCreateGate1.mockReturnValue(mockGate as any);
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      const result = await handlers.review!(makeRun());
      expect(result).toBe('success');
      expect(mockCreateGate1).toHaveBeenCalledWith(['vitest run']);
    });

    it('returns failure when gates fail', async () => {
      const mockGate = { type: 'deterministic', execute: vi.fn() };
      mockCreateGate1.mockReturnValue(mockGate as any);
      mockRunReview.mockResolvedValue({
        passed: false,
        gateResults: [{ gate: 'deterministic', passed: false, findings: [] }],
        fixCycles: 0,
        escalated: false,
      });
      const { handlers } = createHandlers();
      const result = await handlers.review!(makeRun());
      expect(result).toBe('failure');
    });
  });

  describe('report', () => {
    it('posts report, completes work, appends result, and notifies', async () => {
      mockFormatReport.mockReturnValue('test report body');
      const { handlers } = createHandlers();
      const run = makeRun();
      const result = await handlers.report!(run);
      expect(result).toBe('success');
      expect(run.report).toBe('test report body');

      // Verify report was posted
      expect(mockPostReport).toHaveBeenCalledWith(mockOctokit, 'owner', 'repo', 42, 'test report body');

      // Verify result was appended
      expect(mockAppendResult).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          outcome: 'complete',
        }),
        '/tmp/state',
      );

      // Verify work was completed (label + close issue)
      const detector = mockCreateWorkDetector.mock.results[0].value;
      expect(detector.completeWork).toHaveBeenCalledWith(42, 'test report body');

      // Verify notification was sent
      expect(mockNotify).toHaveBeenCalledWith(
        ['https://example.com/hook'],
        expect.objectContaining({
          event: 'complete',
          issueNumber: 42,
        }),
      );
    });
  });
});
