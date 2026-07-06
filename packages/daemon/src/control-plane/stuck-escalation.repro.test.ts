// src/control-plane/stuck-escalation.repro.test.ts
//
// End-to-end repro for the daemon's "Unknown error" stuck failure mode.
//
// Wires the REAL review handler + REAL runReview + REAL createGate1 + REAL
// selectGates into the REAL runPipeline. Only true I/O is stubbed:
//   - runCommand (so gate1's command "fails" deterministically with exit 1)
//   - git (diff for reviewer context)
//   - createReviewerGate (never reached — gate1 fails first — but stubbed for
//     isolation)
//   - the implement coordinator (so the implement phase succeeds, letting the
//     run reach review)
//
// Asserts: gate1 exit-1 → review escalates after maxFixCycles → pipeline goes
// `stuck` AND the terminal result.error contains the real gate finding
// description, NOT "Unknown error" (#1b + #2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Mock only true I/O ---
vi.mock('../lib/process.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('../lib/git.js', () => ({
  git: vi.fn(),
}));

// Reviewer (LLM) gates are I/O; stub them to always pass. They are never
// reached here because gate1 (deterministic) fails first and runReview stops
// on the first failing gate — but stubbing keeps the test hermetic.
vi.mock('../validation/reviewer-session.js', () => ({
  createReviewerGate: vi.fn(() => ({
    type: 'spec-compliance' as const,
    execute: vi.fn(async () => ({
      gate: 'spec-compliance' as const,
      passed: true,
      findings: [],
    })),
  })),
}));

// Keep notify/results/work-detection quiet.
vi.mock('./notify.js', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('./results.js', () => ({ appendResult: vi.fn(async () => {}) }));
vi.mock('./work-detection.js', () => ({
  createWorkDetector: vi.fn(() => ({
    completeWork: vi.fn(async () => ({ ok: true, value: undefined })),
    markStuck: vi.fn(async () => {}),
    claimWork: vi.fn(),
    detectReadyWork: vi.fn(),
  })),
}));
vi.mock('../infra/spec-loader.js', () => ({
  loadSpecContent: vi.fn(async () => ''),
  loadImplementationContent: vi.fn(async () => ''),
  resolveCurrentSpecRefs: vi.fn(async (_root: string, refs: string[]) => refs),
}));

import { createPhaseHandlers } from './phases.js';
import { runPipeline } from './pipeline.js';
import { getPipeline } from './fsm.js';
import { StateManager } from './state.js';
import { CostTracker } from '../session-runtime/cost.js';
import { runCommand } from '../lib/process.js';
import { git } from '../lib/git.js';
import { err } from '../lib/result.js';
import type { Octokit } from '@octokit/rest';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';

const mockRunCommand = vi.mocked(runCommand);
const mockGit = vi.mocked(git);

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
      // The exact real-world gate1 command that runs runforge's own suite.
      gate1Commands: ['pnpm --filter @runforge/daemon run test'],
      maxFixCycles: 4,
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

function makeWorkRequest(): WorkRequest {
  return {
    issueNumber: 42,
    title: 'Self-targeted issue',
    body: 'Fix something in the daemon',
    labels: ['ready'],
    specRefs: [],
  };
}

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ data: { labels: [] } })),
    removeLabel: vi.fn(async () => ({})),
  },
} as unknown as Octokit;
const mockRuntime = {
  spawnSession: vi.fn(),
} as unknown as SessionRuntime;

describe('stuck escalation repro — gate1 exit-1 surfaces a real error (#1b + #2)', () => {
  let stateMgr: StateManager;
  let costTracker: CostTracker;
  let repoRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const stateDir = await mkdtemp(join(tmpdir(), 'stuck-repro-state-'));
    repoRoot = await mkdtemp(join(tmpdir(), 'stuck-repro-repo-'));
    stateMgr = new StateManager(stateDir);
    await stateMgr.initialize();
    costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
    // git diff returns a non-empty diff so reviewer-gate creation proceeds.
    mockGit.mockResolvedValue({
      ok: true,
      value: 'diff --git a/file.ts b/file.ts\n+changed\n',
    });
  });

  it('routes a self-targeted run whose gate1 suite is red to stuck with the real finding (not "Unknown error")', async () => {
    // The cli.test.ts-style stderr the real runCommand produces on exit 1:
    //   "/bin/sh failed (1): <stderr>"
    const GATE1_STDERR =
      'FAIL src/some-unrelated/flaky.test.ts > flake > x\nAssertionError: expected 1 to be 2';
    const gate1Error = new Error(
      `/bin/sh failed (1): ${GATE1_STDERR}`,
    );
    // gate1 runs `pnpm ... test` via runCommand('/bin/sh', ['-c', cmd]).
    mockRunCommand.mockResolvedValue(err(gate1Error));

    const run: RunState = {
      id: 'repro-run',
      issueNumber: 42,
      title: 'Self-targeted issue',
      // Start at review directly: the implement→review loop on escalation needs
      // implement, but we only care about the review→stuck escalation here.
      phase: 'implement',
      variant: 'feature-simple',
      phaseCompletions: { detect: true, classify: true },
      checkpoints: [],
      cost: 0,
      perRunBudget: 10,
      fixAttempts: [],
      errorHashes: {},
      workspacePath: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Coordinator.implement always "succeeds" so the run loops implement→review
    // until review escalates after maxFixCycles.
    const mockCoordinator = {
      implement: vi.fn(async () => ({
        ok: true,
        value: {
          success: true,
          totalCost: 0,
          handoffNotes: undefined,
          containmentBreach: false,
        },
      })),
    } as unknown as ImplementationCoordinator;

    const handlers = createPhaseHandlers(
      makeConfig(),
      'owner',
      'repo',
      mockRuntime,
      mockCoordinator,
      mockOctokit,
      makeWorkRequest(),
      '/tmp/state',
      undefined,
      undefined,
      repoRoot,
    );

    const table = getPipeline('feature-simple');
    const result = await runPipeline(
      run,
      table,
      handlers,
      stateMgr,
      costTracker,
    );

    expect(result.outcome).toBe('stuck');
    expect(run.phase).toBe('stuck');
    // The headline assertion: the terminal error is the REAL gate finding, not
    // the opaque "Unknown error" the daemon used to log.
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('Unknown error');
    expect(result.error).toContain('/bin/sh failed (1)');
    // run.lastFailure carries the same diagnostic (used by the dashboard /
    // markStuck path).
    expect(run.lastFailure?.phase).toBe('review');
    expect(run.lastFailure?.message).toContain('/bin/sh failed (1)');
  });
});
