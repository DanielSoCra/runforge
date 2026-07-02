import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { Config } from '../config.js';
import { CostTracker } from '../session-runtime/cost.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { RunState, WorkRequest } from '../types.js';

vi.mock('./integration.js', () => ({
  integrateToStaging: vi.fn(),
}));

vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn(() => ({
    completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
  })),
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

vi.mock('../validation/deploy.js', () => ({
  runDeploy: vi.fn(),
}));

vi.mock('../validation/post-deploy-test.js', () => ({
  runPostDeployTests: vi.fn(),
}));

import { createPhaseHandlers } from './phases.js';
import { getPipeline } from './fsm.js';
import { integrateToStaging } from './integration.js';
import { runPipeline } from './pipeline.js';
import { StateManager } from './state.js';

const mockIntegrateToStaging = vi.mocked(integrateToStaging);

// `createPhaseHandlers` does not accept a trailing `isPaused` param yet
// (Task 7) — a statically-typed 20-arg call would fail typecheck rather than
// fail RED at runtime. Routed through an untyped alias so arity isn't
// statically checked: today the extra trailing arg is ignored, the pause
// gate never fires, and the parking assertion below fails RED for the
// intended behavioral reason. After Task 7 threads the param, it goes green.
const createPhaseHandlersUntyped = createPhaseHandlers as unknown as (
  ...args: unknown[]
) => ReturnType<typeof createPhaseHandlers>;

describe('phase0 G7 pause gate at integrate entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIntegrateToStaging.mockResolvedValue({
      ok: true,
      value: { success: true, conflicted: false, pushed: true },
    });
  });

  it('parks an integrate-ready run instead of merging when pause is active', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'phase0-pause-integrate-'));
    const stateMgr = new StateManager(stateDir);
    await stateMgr.initialize();
    const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    const isPaused = vi.fn(() => true);
    const run = makeRun();

    const result = await runPipeline(
      run,
      getPipeline('feature-simple'),
      createHandlers(isPaused),
      stateMgr,
      costTracker,
    );

    expect(isPaused).toHaveBeenCalled();
    expect(mockIntegrateToStaging).not.toHaveBeenCalled();
    expect(result.outcome).toBe('parked');
    expect(run.phase).toBe('paused');
    expect(run.pausedAtPhase).toBe('integrate');

    const persisted = await stateMgr.loadRunState(run.issueNumber);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw persisted.error;
    expect(persisted.value.phase).toBe('paused');
    expect(persisted.value.pausedAtPhase).toBe('integrate');
  });
});

function createHandlers(isPaused: () => boolean) {
  return createPhaseHandlersUntyped(
    makeConfig(),
    'owner',
    'repo',
    { spawnSession: vi.fn() } as unknown as SessionRuntime,
    { implement: vi.fn() } as unknown as ImplementationCoordinator,
    mockOctokit,
    makeWorkRequest(),
    '/tmp/state',
    undefined,
    undefined,
    '/tmp/repo-root',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    isPaused,
  );
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    controlPort: 3847,
    pollIntervalMs: 30000,
    maxConcurrentRuns: 1,
    dailyBudget: 50,
    perRunBudget: 10,
    adapter: 'cli',
    runtimeSource: {
      enabled: true,
      requireClean: true,
      requireExpectedRef: true,
      allowSelfRepair: false,
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    },
    branches: { staging: 'staging', production: 'main' },
    webhooks: ['https://example.com/hook'],
    validation: {
      gate1Commands: ['vitest run'],
      maxFixCycles: 3,
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
    diagnosis: { confidenceThreshold: 0.7 },
    warmup: {
      threshold: 10,
      regressionThreshold: 3,
      samplingRate: 0.1,
      minSamplingRate: 0.01,
    },
    gracePeriodMs: 30000,
    activePlugins: [],
    ...overrides,
  } as Config;
}

function makeRun(): RunState {
  return {
    id: 'phase0-g7-run',
    issueNumber: 77,
    title: 'Pause before integrate',
    phase: 'integrate',
    variant: 'feature-simple',
    phaseCompletions: {
      detect: true,
      classify: true,
      implement: true,
      review: true,
      holdout: true,
    },
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

function makeWorkRequest(): WorkRequest {
  return {
    issueNumber: 77,
    title: 'Pause before integrate',
    body: 'Exercise integrate-entry pause gate',
    labels: ['ready'],
    specRefs: [],
  };
}

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ data: { labels: [] } })),
    listComments: vi.fn(async () => ({ data: [] })),
    removeLabel: vi.fn(async () => ({})),
  },
  pulls: {
    merge: vi.fn(async () => ({ data: { merged: true } })),
  },
} as unknown as Octokit;
