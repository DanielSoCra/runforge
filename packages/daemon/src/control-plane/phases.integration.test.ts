// phases.integration.test.ts — Integration tests for createPhaseHandlers
//
// Unlike phases.test.ts (which mocks all 10 dependencies), these tests use
// real implementations of pure-function dependencies to catch wiring bugs
// where a mock's shape diverges from the actual module API. (#139)
//
// Real (unmocked): formatReport, selectGates, isRiskSensitive, routeDiagnosis
// Mocked (I/O): git, createReviewerGate, runReview, postReport, notify,
//               appendResult, createWorkDetector, diagnose, runCommand

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

// Only mock I/O-bound modules — leave pure functions real
vi.mock('../lib/git.js', () => ({
  git: vi.fn(),
}));

vi.mock('../validation/reviewer-session.js', () => ({
  createReviewerGate: vi.fn(() => ({
    type: 'spec-compliance',
    execute: vi.fn(async () => ({ gate: 'spec-compliance', passed: true, findings: [] })),
  })),
}));

vi.mock('../validation/review.js', () => ({
  runReview: vi.fn(),
}));

vi.mock('./reporter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./reporter.js')>();
  return {
    formatReport: real.formatReport, // real implementation
    postReport: vi.fn(async () => ({ ok: true, value: undefined })),
  };
});

vi.mock('./notify.js', () => ({
  notify: vi.fn(async () => {}),
}));

vi.mock('./results.js', () => ({
  appendResult: vi.fn(async () => {}),
}));

vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn(() => ({
    completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
    detectReadyWork: vi.fn(),
    claimWork: vi.fn(),
    markStuck: vi.fn(),
  })),
}));

vi.mock('../diagnosis/diagnostician.js', () => ({
  diagnose: vi.fn(),
}));

// NOT mocked: ../validation/gates.js — selectGates is pure; createGate1 returns
// a gate whose execute() calls runCommand (I/O), but that's safe here because
// runReview is mocked and never invokes gate.execute().
// NOT mocked: ../validation/risk-detection.js (isRiskSensitive is pure)
// NOT mocked: ../diagnosis/router.js (routeDiagnosis is pure)
// reporter.js uses importOriginal because it has mixed exports: formatReport is
// pure but postReport does I/O — so we keep the real formatReport and mock postReport.

import { createPhaseHandlers, releaseDetectLock } from './phases.js';
import { git } from '../lib/git.js';
import { runReview } from '../validation/review.js';
import { diagnose } from '../diagnosis/diagnostician.js';

const mockGit = vi.mocked(git);
const mockRunReview = vi.mocked(runReview);
const mockDiagnose = vi.mocked(diagnose);

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

function makeWorkRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    issueNumber: 42,
    title: 'Test issue',
    body: 'Fix something',
    labels: ['ready'],
    specRefs: [],
    ...overrides,
  };
}

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
  },
} as any;
const mockRuntime = { spawnSession: vi.fn() } as any;

function createHandlers(configOverrides: Partial<Config> = {}, workReq?: WorkRequest) {
  const config = makeConfig(configOverrides);
  const mockCoordinator = { implement: vi.fn() } as any;
  return {
    handlers: createPhaseHandlers(
      config, 'owner', 'repo', mockRuntime, mockCoordinator,
      mockOctokit, workReq ?? makeWorkRequest(), '/tmp/state',
    ),
    coordinator: mockCoordinator,
    config,
  };
}

describe('phases integration (real pure-function wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseDetectLock();
    mockGit.mockResolvedValue({ ok: true, value: 'diff --git a/file.ts b/file.ts\n' });
  });

  afterEach(() => {
    releaseDetectLock();
  });

  describe('review — real selectGates + isRiskSensitive', () => {
    it('selects correct gates for simple non-risk work and passes review', async () => {
      // runReview is mocked but selectGates and isRiskSensitive are REAL.
      // If selectGates signature changes, this test fails at the call site.
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      const { handlers } = createHandlers();
      const result = await handlers.review!(makeRun({ variant: 'feature-simple' }));
      expect(result).toBe('success');

      // Real selectGates for (simple, non-risk) returns exactly 2 gates: gate1 + gate2
      const gates = mockRunReview.mock.calls[0]![0] as any[];
      expect(gates).toHaveLength(2);
      expect(gates[0]).toEqual(expect.objectContaining({ type: 'deterministic' }));
    });

    it('includes all 4 gates for risk-sensitive standard work', async () => {
      mockRunReview.mockResolvedValue({ passed: true, gateResults: [], fixCycles: 0, escalated: false });
      // 'security' label triggers real isRiskSensitive → true
      const workReq = makeWorkRequest({ labels: ['ready', 'security'] });
      const { handlers } = createHandlers({}, workReq);
      const result = await handlers.review!(makeRun({ classificationComplexity: 'standard' }));
      expect(result).toBe('success');

      // Real selectGates with (standard, riskSensitive=true) should include all 4 gates
      const gates = mockRunReview.mock.calls[0]![0] as any[];
      expect(gates.length).toBe(4);
    });
  });

  describe('report — real formatReport', () => {
    it('generates a real report body containing run metadata', async () => {
      const { handlers } = createHandlers();
      const run = makeRun({ cost: 3.25, variant: 'feature-simple' });
      const result = await handlers.report!(run);
      expect(result).toBe('success');

      // Real formatReport should produce a string with the run's data
      expect(run.report).toContain('#42');
      expect(run.report).toContain('$3.25');
      expect(run.report).toContain('feature-simple');
      expect(run.report).toContain('complete');
    });
  });

  describe('diagnose — real routeDiagnosis', () => {
    it('routes Type A high-confidence diagnosis to success via real router', async () => {
      mockDiagnose.mockResolvedValue({
        ok: true,
        value: {
          type: 'A' as const,
          confidence: 0.9,
          affectedSpecs: ['FUNC-AC-PIPELINE'],
          affectedArtifacts: ['src/foo.ts'],
          suggestedAction: 'Fix the code',
          reasoning: 'Spec says X but code does Y',
        },
      });
      const { handlers } = createHandlers();
      const run = makeRun({ variant: 'bug' });
      const result = await handlers.diagnose!(run);

      // Real routeDiagnosis with Type A + confidence 0.9 > threshold 0.7 → bug-pipeline → success
      expect(result).toBe('success');
      expect(run.diagnosisType).toBe('A');
      expect(run.diagnosisConfidence).toBe(0.9);
    });

    it('routes Type B diagnosis to failure and labels needs-spec-update via real router', async () => {
      mockDiagnose.mockResolvedValue({
        ok: true,
        value: {
          type: 'B' as const,
          confidence: 0.85,
          affectedSpecs: ['FUNC-AC-PIPELINE'],
          affectedArtifacts: [],
          suggestedAction: 'Update spec',
          reasoning: 'Spec is incomplete',
        },
      });
      const { handlers } = createHandlers();
      const result = await handlers.diagnose!(makeRun({ variant: 'bug' }));

      // Real routeDiagnosis with Type B → needs-spec-update → failure + label
      expect(result).toBe('failure');
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['needs-spec-update'] }),
      );
    });

    it('routes low-confidence diagnosis to needs-human via real router', async () => {
      mockDiagnose.mockResolvedValue({
        ok: true,
        value: {
          type: 'A' as const,
          confidence: 0.3,
          affectedSpecs: [],
          affectedArtifacts: [],
          suggestedAction: 'Unclear',
          reasoning: 'Not enough data',
        },
      });
      const { handlers } = createHandlers();
      const result = await handlers.diagnose!(makeRun({ variant: 'bug' }));

      // Real routeDiagnosis: confidence 0.3 < threshold 0.7 → needs-human
      expect(result).toBe('failure');
      expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['needs-human'] }),
      );
    });
  });
});
