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
  selectGates: vi.fn(),
}));

vi.mock('../validation/reviewer-session.js', () => ({
  createReviewerGate: vi.fn(),
}));

vi.mock('../validation/risk-detection.js', () => ({
  isRiskSensitive: vi.fn(),
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

vi.mock('../diagnosis/diagnostician.js', () => ({
  diagnose: vi.fn(),
}));

vi.mock('../diagnosis/router.js', () => ({
  routeDiagnosis: vi.fn(),
}));

// Import after mocks are set up
import { createPhaseHandlers, acquireDetectLock, releaseDetectLock, isDetectLocked } from './phases.js';
import { git } from '../lib/git.js';
import { createGate1, selectGates } from '../validation/gates.js';
import { createReviewerGate } from '../validation/reviewer-session.js';
import { isRiskSensitive } from '../validation/risk-detection.js';
import { runReview } from '../validation/review.js';
import { formatReport, postReport } from './reporter.js';
import { notify } from './notify.js';
import { appendResult } from './results.js';
import { createWorkDetector } from './work-detection.js';
import { diagnose } from '../diagnosis/diagnostician.js';
import { routeDiagnosis } from '../diagnosis/router.js';

const mockGit = vi.mocked(git);
const mockDiagnose = vi.mocked(diagnose);
const mockRouteDiagnosis = vi.mocked(routeDiagnosis);
const mockCreateGate1 = vi.mocked(createGate1);
const mockSelectGates = vi.mocked(selectGates);
const mockCreateReviewerGate = vi.mocked(createReviewerGate);
const mockIsRiskSensitive = vi.mocked(isRiskSensitive);
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

function makeRun(overrides: Partial<RunState> = {}): RunState {
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
    ...overrides,
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

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
  },
} as any;
const mockRuntime = { spawnSession: vi.fn() } as any;

function createHandlers(configOverrides: Partial<Config> = {}, workReq?: WorkRequest, repoRoot?: string) {
  const config = makeConfig(configOverrides);
  const mockCoordinator = { implement: vi.fn() } as any;
  return {
    handlers: createPhaseHandlers(
      config, 'owner', 'repo', mockRuntime, mockCoordinator,
      mockOctokit, workReq ?? makeWorkRequest(), '/tmp/state', undefined, undefined, repoRoot,
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
    // Reset octokit mocks
    mockOctokit.issues.addLabels.mockClear();
    mockOctokit.issues.createComment.mockClear();
    // Default: git diff returns empty diff
    mockGit.mockResolvedValue({ ok: true, value: '' });
    // Default: not risk-sensitive
    mockIsRiskSensitive.mockReturnValue(false);
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
      expect(mockGit).toHaveBeenCalledWith(['checkout', 'staging'], undefined);
      expect(mockGit).toHaveBeenCalledWith(['checkout', '-b', 'feature/42', 'staging'], undefined);
    });

    it('checks out existing branch when creation fails', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: false, error: new Error('branch exists') }); // checkout -b fails
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout feature/42
      const { handlers } = createHandlers();
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('success');
      expect(mockGit).toHaveBeenCalledWith(['checkout', 'feature/42'], undefined);
    });

    it('passes repoRoot to git calls instead of relying on process.cwd() (#77)', async () => {
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout staging
      mockGit.mockResolvedValueOnce({ ok: true, value: '' }); // checkout -b feature/42
      const { handlers } = createHandlers({}, undefined, '/custom/repo/root');
      const result = await handlers.detect!(makeRun());
      expect(result).toBe('success');
      expect(mockGit).toHaveBeenCalledWith(['checkout', 'staging'], '/custom/repo/root');
      expect(mockGit).toHaveBeenCalledWith(['checkout', '-b', 'feature/42', 'staging'], '/custom/repo/root');
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
    function setupReviewMocks() {
      const gate1 = { type: 'deterministic' as const, execute: vi.fn() };
      const gate2 = { type: 'spec-compliance' as const, execute: vi.fn() };
      const gate3 = { type: 'quality' as const, execute: vi.fn() };
      const gate4 = { type: 'security' as const, execute: vi.fn() };
      mockCreateGate1.mockReturnValue(gate1 as any);
      mockCreateReviewerGate
        .mockReturnValueOnce(gate2 as any)
        .mockReturnValueOnce(gate3 as any)
        .mockReturnValueOnce(gate4 as any);
      mockSelectGates.mockReturnValue([gate1, gate2]);
      return { gate1, gate2, gate3, gate4 };
    }

    it('returns success when all gates pass', async () => {
      setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      const result = await handlers.review!(makeRun());
      expect(result).toBe('success');
      expect(mockCreateGate1).toHaveBeenCalledWith(['vitest run']);
    });

    it('returns failure when gates fail', async () => {
      setupReviewMocks();
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

    it('creates reviewer gates for spec-compliance, quality, and security (#10)', async () => {
      setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      await handlers.review!(makeRun());

      // All three reviewer gates must be created
      expect(mockCreateReviewerGate).toHaveBeenCalledTimes(3);
      expect(mockCreateReviewerGate).toHaveBeenCalledWith(
        'spec-compliance', 'reviewer-spec',
        expect.any(String), mockRuntime, 42,
        undefined, undefined, expect.any(String), 'Fix something',
      );
      expect(mockCreateReviewerGate).toHaveBeenCalledWith(
        'quality', 'reviewer-quality',
        expect.any(String), mockRuntime, 42,
        undefined, undefined, expect.any(String),
      );
      expect(mockCreateReviewerGate).toHaveBeenCalledWith(
        'security', 'reviewer-security',
        expect.any(String), mockRuntime, 42,
        undefined, undefined, expect.any(String),
      );
    });

    it('calls selectGates with complexity and risk sensitivity (#10)', async () => {
      const { gate1, gate2, gate3, gate4 } = setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      await handlers.review!(makeRun({ variant: 'feature-simple' }));

      expect(mockSelectGates).toHaveBeenCalledWith('simple', false, gate1, gate2, gate3, gate4);
    });

    it('uses standard complexity for feature variant (#10)', async () => {
      setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      await handlers.review!(makeRun({ variant: 'feature' }));

      expect(mockSelectGates).toHaveBeenCalledWith(
        'standard', expect.any(Boolean),
        expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      );
    });

    it('passes risk-sensitive flag from isRiskSensitive (#10)', async () => {
      setupReviewMocks();
      mockIsRiskSensitive.mockReturnValue(true);
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });

      const workReq = makeWorkRequest();
      workReq.labels = ['security'];
      const { handlers } = createHandlers({}, workReq);
      await handlers.review!(makeRun());

      expect(mockIsRiskSensitive).toHaveBeenCalledWith(
        ['security'], expect.stringContaining('Fix something'), [],
      );
      expect(mockSelectGates).toHaveBeenCalledWith(
        'simple', true,
        expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      );
    });

    it('passes maxFixCycles from config to runReview (#10)', async () => {
      setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers({
        validation: {
          gate1Commands: ['test'],
          maxFixCycles: 5,
          staticAnalysis: { maxComplexity: 15, maxFunctionLength: 50, maxFileSize: 500 },
        },
      });
      await handlers.review!(makeRun());

      expect(mockRunReview).toHaveBeenCalledWith(
        expect.any(Array), expect.any(String),
        expect.objectContaining({ maxFixCycles: 5 }),
      );
    });

    it('passes repoRoot to runReview instead of process.cwd() (#77)', async () => {
      setupReviewMocks();
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers({}, undefined, '/custom/repo/root');
      await handlers.review!(makeRun());

      expect(mockRunReview).toHaveBeenCalledWith(
        expect.any(Array), '/custom/repo/root',
        expect.any(Object),
      );
    });
  });

  describe('diagnose (#48)', () => {
    const typeADiagnosis = {
      type: 'A' as const,
      confidence: 0.9,
      affectedSpecs: ['FUNC-AC-PIPELINE'],
      affectedArtifacts: ['src/foo.ts'],
      suggestedAction: 'Fix the implementation',
      reasoning: 'The spec says X but code does Y',
    };

    const typeBDiagnosis = {
      ...typeADiagnosis,
      type: 'B' as const,
      confidence: 0.85,
    };

    it('returns success for Type A diagnosis and records on run state', async () => {
      mockDiagnose.mockResolvedValue({ ok: true, value: typeADiagnosis });
      mockRouteDiagnosis.mockReturnValue({ route: 'bug-pipeline', diagnosis: typeADiagnosis });

      const { handlers } = createHandlers();
      const run = makeRun({ variant: 'bug' });
      const result = await handlers.diagnose!(run);

      expect(result).toBe('success');
      expect(run.diagnosisType).toBe('A');
      expect(run.diagnosisConfidence).toBe(0.9);
      expect(mockDiagnose).toHaveBeenCalledWith(
        mockRuntime, 42, 'Fix something', '', '', undefined, undefined,
      );
      expect(mockRouteDiagnosis).toHaveBeenCalledWith(typeADiagnosis, 0.7);
    });

    it('returns failure and labels needs-spec-update for Type B', async () => {
      mockDiagnose.mockResolvedValue({ ok: true, value: typeBDiagnosis });
      mockRouteDiagnosis.mockReturnValue({ route: 'needs-spec-update', diagnosis: typeBDiagnosis });

      const { handlers } = createHandlers();
      const result = await handlers.diagnose!(makeRun({ variant: 'bug' }));

      expect(result).toBe('failure');
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'owner', repo: 'repo', issue_number: 42,
        labels: ['needs-spec-update'],
      });
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner', repo: 'repo', issue_number: 42,
          body: expect.stringContaining('Type:** B'),
        }),
      );
    });

    it('returns failure and labels needs-human for Type C / low confidence', async () => {
      const lowConf = { ...typeADiagnosis, confidence: 0.3 };
      mockDiagnose.mockResolvedValue({ ok: true, value: lowConf });
      mockRouteDiagnosis.mockReturnValue({
        route: 'needs-human', diagnosis: lowConf, reason: 'Low confidence: 0.3',
      });

      const { handlers } = createHandlers();
      const result = await handlers.diagnose!(makeRun({ variant: 'bug' }));

      expect(result).toBe('failure');
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'owner', repo: 'repo', issue_number: 42,
        labels: ['needs-human'],
      });
    });

    it('returns failure and labels needs-human when diagnosis errors', async () => {
      mockDiagnose.mockResolvedValue({ ok: false, error: new Error('invalid output') });

      const { handlers } = createHandlers();
      const result = await handlers.diagnose!(makeRun({ variant: 'bug' }));

      expect(result).toBe('failure');
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'owner', repo: 'repo', issue_number: 42,
        labels: ['needs-human'],
      });
      expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('Diagnosis Failed'),
        }),
      );
    });

    it('uses config.diagnosis.confidenceThreshold', async () => {
      mockDiagnose.mockResolvedValue({ ok: true, value: typeADiagnosis });
      mockRouteDiagnosis.mockReturnValue({ route: 'bug-pipeline', diagnosis: typeADiagnosis });

      const { handlers } = createHandlers({
        diagnosis: { confidenceThreshold: 0.9 },
      });
      await handlers.diagnose!(makeRun({ variant: 'bug' }));

      expect(mockRouteDiagnosis).toHaveBeenCalledWith(typeADiagnosis, 0.9);
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
      const detector = mockCreateWorkDetector.mock.results[0]!.value;
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

    it('returns success even when postReport throws (#107)', async () => {
      mockPostReport.mockRejectedValue(new Error('GitHub API 500'));
      const { handlers } = createHandlers();
      const result = await handlers.report!(makeRun());
      expect(result).toBe('success');
    });

    it('returns success even when completeWork throws (#107)', async () => {
      mockCreateWorkDetector.mockReturnValue({
        completeWork: vi.fn(async () => { throw new Error('network timeout'); }),
        detectReadyWork: vi.fn(),
        claimWork: vi.fn(),
        markStuck: vi.fn(),
      } as any);
      const { handlers } = createHandlers();
      const result = await handlers.report!(makeRun());
      expect(result).toBe('success');
    });

    it('returns success even when appendResult throws (#107)', async () => {
      mockAppendResult.mockRejectedValue(new Error('disk full'));
      const { handlers } = createHandlers();
      const result = await handlers.report!(makeRun());
      expect(result).toBe('success');
    });

    it('returns success even when notify throws (#107)', async () => {
      mockNotify.mockRejectedValue(new Error('webhook unreachable'));
      const { handlers } = createHandlers();
      const result = await handlers.report!(makeRun());
      expect(result).toBe('success');
    });

    it('continues remaining steps when an earlier step fails (#107)', async () => {
      // postReport fails, but completeWork, appendResult, notify should still run
      mockPostReport.mockRejectedValue(new Error('GitHub API 500'));
      const { handlers } = createHandlers();
      await handlers.report!(makeRun());

      const detector = mockCreateWorkDetector.mock.results[0]!.value;
      expect(detector.completeWork).toHaveBeenCalled();
      expect(mockAppendResult).toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalled();
    });
  });
});
