// packages/daemon/src/control-plane/gateset-verdict-wiring.integration.test.ts
//
// IMMOVABLE acceptance gate for XCUT P2#1 — the lane-specific gate-set VERDICT
// wired into the `integrate` phase handler. Sibling of
// merge-decision-wiring.integration.test.ts; reuses that harness's mock set and
// createPhaseHandlers construction verbatim, adding the `gateSets` deployment
// config + `run.passedGates` observation that this slice introduces.
//
// SPY SEAM: integrateToStaging is the merge action we assert on (did the run
// merge, or did it park + raise a DecisionRequest because the lane's gate-set was
// not satisfied). No new injection point is added to phases.ts.
//
// RED at handoff: phases.ts still hardcodes `validationPassed = true`, so the
// gate-set-NOT-satisfied scenario (a) MERGES today (wrong) — the test asserts it
// parks. (b) and (c) pass today and must keep passing. Do NOT weaken.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

// --- I/O mocks (mirror merge-decision-wiring.integration.test.ts) ----------
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
vi.mock('./merge-decision/touched-paths.js', () => ({ computeTouchedPaths: vi.fn() }));
vi.mock('./merge-decision/observe-verifier.js', () => ({ observeVerifierStatus: vi.fn() }));

// --- imports after mocks ---------------------------------------------------
import { createPhaseHandlers, releaseDetectLock } from './phases.js';
import { git } from '../lib/git.js';
import { integrateToStaging } from './integration.js';
import { computeTouchedPaths } from './merge-decision/touched-paths.js';
import { observeVerifierStatus } from './merge-decision/observe-verifier.js';
import { DeploymentRegistry } from './deployment-registry/registry.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import type { GitHubBlockPublisher } from './decision-escalation/github-block-notifier.js';
import type { Octokit } from '@octokit/rest';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';

const mockGit = vi.mocked(git);
const mockIntegrate = vi.mocked(integrateToStaging);
const mockTouchedPaths = vi.mocked(computeTouchedPaths);
const mockObserveVerifier = vi.mocked(observeVerifierStatus);

const DEPLOYMENT_ID = 'dep-a';

// The auto lane selects gateSet 'gate1-deterministic-only'; the most-cautious
// fallback selects 'full-ladder'. gateSets is supplied per-test so the inert
// (absent) baseline is exercisable too.
function makeProfile(gateSets?: Record<string, { required: string[] }>) {
  const profile: Record<string, unknown> = {
    repositories: [{ owner: 'owner', name: 'repo' }],
    riskPathMap: [],
    defaultMinLevel: 'green',
    laneSet: {
      declaredPhases: ['velocity'],
      mostCautiousLane: 'standard',
      lanes: [
        {
          name: 'auto',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: {},
          gateSet: 'gate1-deterministic-only',
          mergePolicy: 'auto',
          verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
        },
        {
          name: 'standard',
          qualify: { complexity: ['standard', 'complex'] },
          allowedPaths: ['**'],
          roleRouting: {},
          gateSet: 'full-ladder',
          mergePolicy: 'hold',
          verifier: { kind: 'test-suite', invoke: { ref: 'pnpm test' } },
        },
      ],
    },
    lifecycleMode: 'velocity',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 1000,
    landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy', requiredChecks: ['ci'] },
    capabilityBindings: [],
  };
  if (gateSets !== undefined) profile.gateSets = gateSets;
  return profile;
}

/** Register the deployment + widen green; gateSets passed through to the profile. */
function registryWidenedGreen(gateSets?: Record<string, { required: string[] }>): DeploymentRegistry {
  const reg = new DeploymentRegistry();
  const out = reg.register(DEPLOYMENT_ID, makeProfile(gateSets));
  if (!out.ok) throw new Error(`fixture profile rejected: ${out.offenders.join('; ')}`);
  const w = reg.recordWidening(
    DEPLOYMENT_ID,
    'green',
    'widened',
    { kind: 'operator-grant', operator: 'daniel' },
    Date.UTC(2026, 5, 2),
  );
  if (!w.ok) throw new Error(`widening rejected: ${w.reason}`);
  return reg;
}

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
} as unknown as Octokit;
const mockRuntime = { spawnSession: vi.fn() } as unknown as SessionRuntime;

function createHandlers(opts: {
  config?: Partial<Config>;
  registry?: DeploymentRegistry;
  decisionManager?: DecisionIndexManager;
  decisionPublisher?: GitHubBlockPublisher;
} = {}) {
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
      undefined,
      undefined,
      undefined,
      opts.decisionManager,
      opts.decisionPublisher,
      opts.registry,
    ),
    config,
  };
}

function makeDecisionDouble() {
  const raise = vi.fn().mockReturnValue({ decision_id: 'issue-42:integrate:1', outcome: 'admitted' });
  const notify = vi.fn().mockResolvedValue({ applied: true, status: 'notified' });
  const ensure = vi.fn().mockResolvedValue({ posted: true });
  const markRuntimeDegraded = vi.fn();
  const clearRuntimeDegraded = vi.fn();
  const manager = {
    isEnabled: () => true,
    isAvailable: () => true,
    ledger: () => ({ raise, notify }),
    markRuntimeDegraded,
    clearRuntimeDegraded,
  } as unknown as DecisionIndexManager;
  const publisher = { ensure } as unknown as GitHubBlockPublisher;
  return { manager, publisher, raise, notify, ensure, markRuntimeDegraded, clearRuntimeDegraded };
}

describe('gate-set verdict live wiring — integrate handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseDetectLock();
    mockGit.mockResolvedValue({ ok: true, value: '' });
    mockIntegrate.mockResolvedValue({
      ok: true,
      value: { success: true, conflicted: false, pushed: true },
    } as unknown as Awaited<ReturnType<typeof integrateToStaging>>);
    mockTouchedPaths.mockResolvedValue(['docs/readme.md']);
    mockObserveVerifier.mockReturnValue({ observed: true, runnable: true, falsifying: true });
  });

  afterEach(() => {
    releaseDetectLock();
  });

  it('(a) lane gate-set requires a gate NOT in run.passedGates → parks + escalates verification-not-passed, does NOT merge (autonomy widened, verifier good)', async () => {
    const decision = makeDecisionDouble();
    // The auto lane selects 'gate1-deterministic-only', which REQUIRES 'deterministic'.
    // The run recorded only 'spec-compliance' as passed — the required gate is absent.
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryWidenedGreen({
        'gate1-deterministic-only': { required: ['deterministic'] },
        'full-ladder': { required: ['deterministic', 'quality', 'security'] },
      }),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun({ passedGates: ['spec-compliance'] });

    await handlers.integrate!(run);

    // Without the verdict wiring (validationPassed hardcoded true), this MERGES —
    // so this assertion is RED today. With the wiring: validationPassed=false ⇒
    // decideMerge escalates verification-not-passed ⇒ the run parks, does not merge.
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBe('integrate');
    expect(decision.raise).toHaveBeenCalledTimes(1);
    expect(run.mergeDecision?.kind).not.toBe('auto-merge');
  });

  it('(b) run.passedGates satisfies the lane gate-set → proceeds (auto-merges), no DecisionRequest', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryWidenedGreen({
        'gate1-deterministic-only': { required: ['deterministic'] },
        'full-ladder': { required: ['deterministic', 'quality', 'security'] },
      }),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    // The required 'deterministic' gate IS present (plus an extra, which is ignored).
    const run = makeRun({ passedGates: ['deterministic', 'spec-compliance'] });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // The merge happens via the PR lane against the declared trunk.
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: 'feature/42' }),
    );
    expect(mockOctokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 101, merge_method: 'squash' }),
    );
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBeUndefined();
    expect(decision.raise).not.toHaveBeenCalled();
  });

  it('(c) deployment declares NO gateSets → verdict feature inert, validationPassed stays true, auto-merges', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryWidenedGreen(/* no gateSets */),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    // No passedGates recorded at all — but with the feature inert it does not matter.
    const run = makeRun();

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // The merge happens via the PR lane against the declared trunk.
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'main', head: 'feature/42' }),
    );
    expect(mockOctokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 101, merge_method: 'squash' }),
    );
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBeUndefined();
    expect(decision.raise).not.toHaveBeenCalled();
  });

  it('(d) a declared-but-dangling lane→gate-set reference is REJECTED at registration — it never reaches integrate (codex)', () => {
    // A dangling reference (gateSets declared but missing a lane's named set) is
    // caught at pack activation by parseProfile, so it can never reach the
    // integrate seam through a registered profile. This is the stronger placement
    // of the fail-closed guard (at the door, not at runtime). The integrate
    // handler keeps a `definition===undefined → false` fail-close as pure
    // defense-in-depth, but a registered profile can no longer produce that state.
    const reg = new DeploymentRegistry();
    const out = reg.register(
      DEPLOYMENT_ID,
      makeProfile({ 'some-other-set': { required: ['deterministic'] } }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const joined = out.offenders.join('\n');
      expect(joined).toContain('gate1-deterministic-only');
      expect(joined).toContain('full-ladder');
    }
  });
});
