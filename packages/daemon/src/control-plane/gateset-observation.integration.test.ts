// packages/daemon/src/control-plane/gateset-observation.integration.test.ts
//
// IMMOVABLE acceptance contract for the gate OBSERVATION half of XCUT P2#1: the
// review handler records the PASSING gateResults keys onto run.passedGates, and
// the holdout handler APPENDS 'holdout' when its scenarios pass. Mirrors the
// review/holdout harness used in phases.test.ts (same mock set + createHandlers).
//
// RED at handoff: the handlers do not populate run.passedGates yet. Do NOT weaken.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

vi.mock('../lib/git.js', () => ({ git: vi.fn() }));
vi.mock('../validation/gates.js', () => ({ createGate1: vi.fn(), selectGates: vi.fn() }));
vi.mock('../validation/reviewer-session.js', () => ({ createReviewerGate: vi.fn() }));
vi.mock('../validation/risk-detection.js', () => ({ isRiskSensitive: vi.fn(() => false) }));
vi.mock('../validation/review.js', () => ({ runReview: vi.fn() }));
vi.mock('./reporter.js', () => ({
  formatReport: vi.fn(() => 'mock report'),
  postReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));
vi.mock('./notify.js', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('./results.js', () => ({ appendResult: vi.fn(async () => {}) }));
vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn(() => ({
    completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
  })),
}));
vi.mock('../diagnosis/diagnostician.js', () => ({ diagnose: vi.fn() }));
vi.mock('../diagnosis/router.js', () => ({ routeDiagnosis: vi.fn() }));
vi.mock('../infra/spec-loader.js', () => ({
  loadSpecContent: vi.fn(async () => ''),
  loadImplementationContent: vi.fn(async () => ''),
  resolveCurrentSpecRefs: vi.fn(),
}));
vi.mock('./classifier.js', () => ({ classify: vi.fn() }));
vi.mock('../lib/process.js', () => ({ runCommand: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});
vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace.js')>();
  return {
    ...actual,
    ensureRepoFresh: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
});
vi.mock('../validation/holdout.js', () => ({ runHoldout: vi.fn() }));
vi.mock('./integration.js', () => ({ integrateToStaging: vi.fn() }));

import { createPhaseHandlers, releaseDetectLock } from './phases.js';
import { git } from '../lib/git.js';
import { createGate1, selectGates } from '../validation/gates.js';
import { createReviewerGate } from '../validation/reviewer-session.js';
import { runReview } from '../validation/review.js';
import { runHoldout } from '../validation/holdout.js';
import type { Octokit } from '@octokit/rest';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { Gate } from '../validation/gates.js';

const mockGit = vi.mocked(git);
const mockCreateGate1 = vi.mocked(createGate1);
const mockSelectGates = vi.mocked(selectGates);
const mockCreateReviewerGate = vi.mocked(createReviewerGate);
const mockRunReview = vi.mocked(runReview);
const mockRunHoldout = vi.mocked(runHoldout);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    controlPort: 3847,
    pollIntervalMs: 30000,
    maxConcurrentRuns: 1,
    dailyBudget: 50,
    perRunBudget: 10,
    adapter: 'cli',
    branches: { staging: 'staging', production: 'main' },
    webhooks: [],
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
      ...(overrides.validation ?? {}),
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
    phase: 'review',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true, implement: true },
    checkpoints: [],
    cost: 1.5,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: 'owner',
    repoName: 'repo',
    body: 'Fix something',
    startedAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
    ...overrides,
  };
}

function makeWorkRequest(): WorkRequest {
  return { issueNumber: 42, title: 'Test issue', body: 'Fix something', labels: ['ready'], specRefs: [] };
}

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ data: { labels: [] } })),
  },
  pulls: { merge: vi.fn(async () => ({ data: { merged: true } })) },
} as unknown as Octokit;
const mockRuntime = { spawnSession: vi.fn() } as unknown as SessionRuntime;

function createHandlers(opts: { config?: Partial<Config> } = {}) {
  const config = makeConfig(opts.config);
  const mockCoordinator = { implement: vi.fn() } as unknown as ImplementationCoordinator;
  return {
    handlers: createPhaseHandlers(
      config,
      'owner',
      'repo',
      mockRuntime,
      mockCoordinator,
      mockOctokit,
      makeWorkRequest(),
      '/tmp/state',
      undefined,
      undefined,
      '/tmp/repo-root',
    ),
    config,
  };
}

function setupReviewMocks() {
  const gate1 = { type: 'deterministic' as const, execute: vi.fn() } as unknown as Gate;
  const gate2 = { type: 'spec-compliance' as const, execute: vi.fn() } as unknown as Gate;
  const gate3 = { type: 'quality' as const, execute: vi.fn() } as unknown as Gate;
  const gate4 = { type: 'security' as const, execute: vi.fn() } as unknown as Gate;
  mockCreateGate1.mockReturnValue(gate1);
  mockCreateReviewerGate
    .mockReturnValueOnce(gate2)
    .mockReturnValueOnce(gate3)
    .mockReturnValueOnce(gate4);
  mockSelectGates.mockReturnValue([gate1, gate2, gate3, gate4]);
}

describe('gate observation — run.passedGates population', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseDetectLock();
    // A NON-empty diff so the review handler actually runs gates (an empty diff
    // skips all gates — the legacy no-code path — and records no passed gates).
    mockGit.mockResolvedValue({ ok: true, value: 'diff --git a/f b/f\n+code' });
  });
  afterEach(() => {
    releaseDetectLock();
  });

  it('review handler records the PASSING gateResults keys onto run.passedGates', async () => {
    setupReviewMocks();
    mockRunReview.mockResolvedValue({
      passed: true,
      gateResults: [
        { gate: 'deterministic', passed: true, findings: [] },
        { gate: 'spec-compliance', passed: true, findings: [] },
        { gate: 'quality', passed: true, findings: [] },
        { gate: 'security', passed: true, findings: [] },
      ],
      fixCycles: 0,
      escalated: false,
    } as unknown as Awaited<ReturnType<typeof runReview>>);
    const { handlers } = createHandlers();
    const run = makeRun();

    const result = await handlers.review!(run);

    expect(result).toBe('success');
    expect(new Set(run.passedGates)).toEqual(
      new Set(['deterministic', 'spec-compliance', 'quality', 'security']),
    );
  });

  it('review handler records ONLY the passing gates, not the failing ones (when review still passes overall)', async () => {
    // A gate-set verdict must observe per-gate outcomes; a gate that did not pass
    // must never appear in passedGates even on an overall-success review result.
    setupReviewMocks();
    mockRunReview.mockResolvedValue({
      passed: true,
      gateResults: [
        { gate: 'deterministic', passed: true, findings: [] },
        { gate: 'security', passed: false, findings: [] },
      ],
      fixCycles: 0,
      escalated: false,
    } as unknown as Awaited<ReturnType<typeof runReview>>);
    const { handlers } = createHandlers();
    const run = makeRun();

    await handlers.review!(run);

    expect(run.passedGates).toContain('deterministic');
    expect(run.passedGates ?? []).not.toContain('security');
  });

  it('an EMPTY diff skips all gates and does NOT populate passedGates (legacy skip preserved, codex)', async () => {
    // No-code/spec-only work: gate1 against the baseline would fail on pre-existing
    // failures, so review skips all gates and returns success. No gates ran ⇒
    // passedGates stays unset; a lane gate-set requiring gates then fails CLOSED at
    // integrate rather than this run auto-merging on phantom observations.
    setupReviewMocks();
    mockGit.mockResolvedValue({ ok: true, value: '   \n  ' }); // whitespace-only diff
    const { handlers } = createHandlers();
    // Seed STALE observations from a prior review cycle — a re-entry with an empty
    // diff must CLEAR them (no gates ran for the current content), so the verdict
    // fails closed rather than satisfying from gates that never ran (codex P1).
    const run = makeRun({ passedGates: ['deterministic', 'quality'] });

    const result = await handlers.review!(run);

    expect(result).toBe('success');
    expect(run.passedGates ?? []).toEqual([]);
    expect(mockRunReview).not.toHaveBeenCalled();
  });

  it('holdout handler APPENDS holdout to run.passedGates when scenarios pass', async () => {
    mockRunHoldout.mockResolvedValue({
      ok: true,
      value: { passed: true, failures: [] },
    } as unknown as Awaited<ReturnType<typeof runHoldout>>);
    const { handlers } = createHandlers({
      config: { validation: { holdoutCommand: 'pnpm holdout' } as Config['validation'] },
    });
    // The run already recorded its review gates; holdout adds 'holdout' on top.
    const run = makeRun({ phase: 'holdout', passedGates: ['deterministic', 'spec-compliance'] });

    const result = await handlers.holdout!(run);

    expect(result).toBe('success');
    expect(run.passedGates).toContain('holdout');
    // It APPENDS — the prior review keys survive.
    expect(run.passedGates).toContain('deterministic');
    expect(run.passedGates).toContain('spec-compliance');
  });
});
