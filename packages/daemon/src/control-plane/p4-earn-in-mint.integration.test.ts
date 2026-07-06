// packages/daemon/src/control-plane/p4-earn-in-mint.integration.test.ts
// Implementer-owned integration tests for the earn-in mint seam (Tasks 9/10):
// F17 same-run auto-widen → auto-merge, and F19 fail-closed on recordWidening error.
// Uses the same module-mock harness style as merge-decision-wiring.integration.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

vi.mock('../lib/git.js', () => ({ git: vi.fn() }));
vi.mock('../validation/gates.js', () => ({ createGate1: vi.fn(), selectGates: vi.fn() }));
vi.mock('../validation/reviewer-session.js', () => ({ createReviewerGate: vi.fn() }));
vi.mock('../validation/risk-detection.js', () => ({ isRiskSensitive: vi.fn() }));
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
  loadSpecContent: vi.fn(),
  loadImplementationContent: vi.fn(),
  resolveCurrentSpecRefs: vi.fn(),
}));
vi.mock('./spec-pipeline/delivery.js', () => {
  class DeliveryError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.name = 'DeliveryError';
      this.kind = kind;
    }
  }
  return {
    DeliveryError,
    deliverPhaseArtifact: vi.fn(),
    reconcilePhaseArtifact: vi.fn(),
    mergePhaseArtifact: vi.fn(),
    buildProposalKey: vi.fn(({ owner, repo, issueNumber, phase, baseBranch }: Record<string, unknown>) =>
      `${owner}/${repo}#${issueNumber}:${phase}:${baseBranch}`),
  };
});
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
vi.mock('../validation/deploy.js', () => ({ runDeploy: vi.fn() }));
vi.mock('../validation/post-deploy-test.js', () => ({ runPostDeployTests: vi.fn() }));
vi.mock('./merge-decision/touched-paths.js', () => ({
  computeTouchedPaths: vi.fn(),
}));
vi.mock('./merge-decision/observe-verifier.js', () => ({
  observeVerifierStatus: vi.fn(),
}));

import { createPhaseHandlers } from './phases.js';
import { git } from '../lib/git.js';
import { integrateToStaging } from './integration.js';
import { computeTouchedPaths } from './merge-decision/touched-paths.js';
import { observeVerifierStatus } from './merge-decision/observe-verifier.js';
import { DeploymentRegistry } from './deployment-registry/registry.js';
import { JsonFileAutonomyStore } from './deployment-registry/registry.js';
import { laneOutcomesPath } from './lane-engine/outcome-ledger.js';
import type { ReleaseLedgerManager } from './release/release-ledger-manager.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockGit = vi.mocked(git);
const mockIntegrate = vi.mocked(integrateToStaging);
const mockTouchedPaths = vi.mocked(computeTouchedPaths);
const mockObserveVerifier = vi.mocked(observeVerifierStatus);

const DEPLOYMENT_ID = 'dep-a';
const ISSUE = 42;
const NOW = Date.UTC(2026, 6, 3);
const DAY = 86_400_000;

function makeProfile() {
  return {
    repositories: [{ owner: 'owner', name: 'repo' }],
    riskPathMap: [],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity'],
      mostCautiousLane: 'standard',
      lanes: [
        {
          name: 'fast',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: {},
          gateSet: 'gate1',
          mergePolicy: 'auto',
          earnIn: { cleanMerges: 10, bounceFreeDays: 30 },
          preApprovedEarnIn: { enabled: true, policyRef: 'ops-pack-v1' },
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
    landing: { landsOn: 'main', productionReleasePath: { kind: 'platform-performs' }, requiredChecks: ['ci'] },
    capabilityBindings: [],
  };
}

function makeRegistry(stateDir: string, recordWideningOk = true): DeploymentRegistry {
  const store = new JsonFileAutonomyStore(join(stateDir, 'autonomy.json'));
  const reg = new DeploymentRegistry({ autonomyStore: store });
  const out = reg.register(DEPLOYMENT_ID, makeProfile());
  if (!out.ok) throw new Error(`fixture profile rejected: ${out.offenders.join('; ')}`);
  if (!recordWideningOk) {
    const original = reg.recordWidening.bind(reg);
    reg.recordWidening = (...args: Parameters<typeof original>) => {
      // Fail the specific earn-in-policy widening while leaving other calls intact.
      if (args[3].kind === 'earn-in-policy') {
        return { ok: false, reason: 'simulated persistence failure' };
      }
      return original(...args);
    };
  }
  return reg;
}

function seedOutcomes(stateDir: string): void {
  const path = laneOutcomesPath(stateDir);
  // Space the 12 clean merges every 3 days so the EARLIEST is 33 days ago: the
  // lane genuinely earns >= 30 bounce-free days (the declared `earnIn.bounceFreeDays`
  // floor) while keeping 11 merges inside the 30-day recency window (>= minCleanMerges
  // 10). A tighter span would only clear the earn-in bar under the pre-fix bug where a
  // no-bounce lane was credited the full window regardless of elapsed time.
  const outcomes = Array.from({ length: 12 }, (_v, i) => ({
    ts: new Date(NOW - i * 3 * DAY).toISOString(),
    deploymentId: DEPLOYMENT_ID,
    lane: 'fast',
    kind: 'clean-merge' as const,
    riskClass: 'green' as const,
    issueNumber: ISSUE,
  }));
  // Use synchronous fs because this is test fixture setup.
  mkdirSync(join(stateDir, 'metrics'), { recursive: true });
  writeFileSync(path, JSON.stringify(outcomes, null, 2));
}

function makeConfig(): Config {
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
    },
    diagnosis: { confidenceThreshold: 0.7 },
    warmup: { threshold: 10, regressionThreshold: 3, samplingRate: 0.1, minSamplingRate: 0.01 },
    gracePeriodMs: 30000,
    activePlugins: [],
  } as unknown as Config;
}

function makeRun(): RunState {
  return {
    id: 'test-run',
    issueNumber: ISSUE,
    title: 'Test issue',
    phase: 'integrate',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true },
    checkpoints: [],
    cost: 1.5,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: 'owner',
    repoName: 'repo',
    startedAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
    deploymentId: DEPLOYMENT_ID,
    classificationComplexity: 'simple',
    classifierChangeKind: 'docs',
    passedGates: ['deterministic'],
  };
}

function makeWorkRequest(): WorkRequest {
  return { issueNumber: ISSUE, title: 'Test issue', body: 'Fix something', labels: ['ready'], specRefs: [] };
}

const mockOctokit = {
  issues: {
    addLabels: vi.fn(async () => ({})),
    createComment: vi.fn(async () => ({})),
    get: vi.fn(async () => ({ data: { labels: [] } })),
    listComments: vi.fn(async () => ({ data: [] })),
  },
  pulls: {
    list: vi.fn(async () => ({ data: [] })),
    create: vi.fn(async () => ({
      data: { number: 101, html_url: 'https://github.com/owner/repo/pull/101', head: { ref: 'feature/42' }, base: { ref: 'main' } },
    })),
    merge: vi.fn(async () => ({ data: { merged: true, sha: 'deadbeef' } })),
  },
  checks: {
    listForRef: vi.fn(async () => ({
      data: {
        total_count: 1,
        check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      },
    })),
  },
  repos: {
    getCombinedStatusForRef: vi.fn(async () => ({
      data: { state: 'success', statuses: [] },
    })),
  },
} as any;
const mockRuntime = { spawnSession: vi.fn() } as any;

function makeReleaseLedgerReader(hasDebutAuthorization = true): {
  reader: { hasDebutAuthorization: () => Promise<boolean> };
  ledger: () => { reader: () => { hasDebutAuthorization: () => Promise<boolean> } };
  isAvailable: () => boolean;
} {
  const reader = { hasDebutAuthorization: async () => hasDebutAuthorization };
  return {
    reader,
    ledger: () => ({ reader: () => reader }),
    isAvailable: () => true,
  };
}

function createHandlers(opts: {
  stateDir: string;
  registry?: DeploymentRegistry;
  releaseLedgerManager?: ReturnType<typeof makeReleaseLedgerReader>;
}) {
  const mockCoordinator = { implement: vi.fn() } as any;
  return {
    handlers: createPhaseHandlers(
      makeConfig(),
      'owner',
      'repo',
      mockRuntime,
      mockCoordinator,
      mockOctokit,
      makeWorkRequest(),
      opts.stateDir,
      undefined,
      undefined,
      opts.stateDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts.registry,
      undefined,
      undefined,
      () => false,
      undefined,
      opts.releaseLedgerManager as unknown as ReleaseLedgerManager | undefined,
    ),
  };
}

describe('earn-in mint seam — same-run auto-widen (F17)', () => {
  const dirs: string[] = [];
  const tmpDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'p4-earnin-mint-'));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The seeded outcome window is relative to NOW; keep the recency floor stable.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    // git() returns a Result<string> — a successful push is { ok: true, value }.
    mockGit.mockResolvedValue({ ok: true, value: '' } as any);
    mockIntegrate.mockResolvedValue({ ok: true, merged: true, mergeSha: 'deadbeef' } as any);
    mockTouchedPaths.mockResolvedValue(['docs/readme.md']);
    mockObserveVerifier.mockReturnValue({ observed: true, runnable: true, falsifying: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) {
      const d = dirs.pop();
      if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
  });

  it('F17 — a cleared lane auto-widens and decideMerge returns auto-merge in the SAME run', async () => {
    const stateDir = tmpDir();
    const registry = makeRegistry(stateDir);
    seedOutcomes(stateDir);
    const releaseLedgerManager = makeReleaseLedgerReader(true);
    const { handlers } = createHandlers({ stateDir, registry, releaseLedgerManager });

    const run = makeRun();
    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    expect(run.mergeDecision?.kind).toBe('auto-merge');
    expect(run.mergeDecision?.lane.name).toBe('fast');
    // Governed auto-merge lands via deliverCodeChangeViaPR → octokit.pulls.merge,
    // NOT the legacy ungoverned integrateToStaging seam.
    expect(mockOctokit.pulls.merge).toHaveBeenCalled();
  });

  it('F19 — when recordWidening fails, the run does NOT auto-merge on an unrecorded widening', async () => {
    const stateDir = tmpDir();
    const registry = makeRegistry(stateDir, false);
    seedOutcomes(stateDir);
    const releaseLedgerManager = makeReleaseLedgerReader(true);
    const { handlers } = createHandlers({ stateDir, registry, releaseLedgerManager });

    const run = makeRun();
    const result = await handlers.integrate!(run);

    expect(result).not.toBe('success');
    expect(run.mergeDecision?.kind).not.toBe('auto-merge');
    // A fail-closed run must never reach the real merge seam.
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });
});
