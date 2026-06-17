// packages/daemon/src/control-plane/merge-decision-wiring.integration.test.ts
//
// IMMOVABLE acceptance gate for slice 5b — the LIVE wiring of the merge-decision
// core into the `integrate` phase handler. Reuses the phases.test.ts harness
// style: the same I/O mocks, the same createPhaseHandlers construction, the same
// decisionManager / publisher doubles the l2-gate tests use.
//
// SPY SEAM for integrateToStaging: this file mocks './integration.js' (exactly as
// phases.test.ts does), so `integrateToStaging` is a vi.fn() spy. The merge gate's
// confidence check is "did the run call integrateToStaging, or did it park and
// raise a DecisionRequest instead". That spy is the assertion surface — no new
// injection point is introduced into phases.ts (the existing module-mock seam
// suffices, mirroring the integrate-handler tests in phases.test.ts).
//
// The two live shims (observe-verifier.js, touched-paths.js) are module-mocked so
// the wired handler's git/observation I/O is controlled here:
//   - computeTouchedPaths → in-scope docs path (so the auto lane stays in-scope).
//   - observeVerifierStatus → a present + runnable + falsifying status (so the
//     verifier gate passes and the decision turns on autonomy, not the gate).
//
// RED until Kimi wires the `integrate` handler. With the unconditional
// integrateToStaging body shipping today, scenario (a) FAILS (the handler merges
// instead of parking) and (b)/(c) PASS — i.e. the suite is RED at handoff, which
// is the gate's contract. Do NOT weaken these tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunState, WorkRequest } from '../types.js';
import type { Config } from '../config.js';

// --- I/O mocks (mirror phases.test.ts) -------------------------------------
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

// The SPY SEAM: integrateToStaging is the merge action we assert on.
vi.mock('./integration.js', () => ({ integrateToStaging: vi.fn() }));

vi.mock('../validation/deploy.js', () => ({ runDeploy: vi.fn() }));
vi.mock('../validation/post-deploy-test.js', () => ({ runPostDeployTests: vi.fn() }));

// The two live shims — controlled so the gate's decision turns on autonomy.
vi.mock('./merge-decision/touched-paths.js', () => ({
  computeTouchedPaths: vi.fn(),
}));
vi.mock('./merge-decision/observe-verifier.js', () => ({
  observeVerifierStatus: vi.fn(),
}));

// --- imports after mocks ---------------------------------------------------
import { createPhaseHandlers, releaseDetectLock } from './phases.js';
import { git } from '../lib/git.js';
import { integrateToStaging } from './integration.js';
import { computeTouchedPaths } from './merge-decision/touched-paths.js';
import { observeVerifierStatus } from './merge-decision/observe-verifier.js';
import { DeploymentRegistry } from './deployment-registry/registry.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import type { GitHubBlockPublisher } from './decision-escalation/github-block-notifier.js';

const mockGit = vi.mocked(git);
const mockIntegrate = vi.mocked(integrateToStaging);
const mockTouchedPaths = vi.mocked(computeTouchedPaths);
const mockObserveVerifier = vi.mocked(observeVerifierStatus);

const DEPLOYMENT_ID = 'dep-a';

// A profile with an `auto` lane that qualifies on a 'simple'/'docs' verdict,
// allows docs paths, declares a verifier, and requests `auto`; plus a
// most-cautious `standard` fallback. Mirrors registry.test.ts's makeProfile but
// adds the verifier so the verifier gate can pass.
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
          name: 'auto',
          qualify: { complexity: ['simple'], changeKind: ['docs'] },
          allowedPaths: ['docs/**'],
          roleRouting: {},
          gateSet: 'gate1',
          mergePolicy: 'auto',
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
    landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
    capabilityBindings: [],
  };
}

/** A registry with the deployment registered + green autonomy widened. */
function registryWithWidenedGreen(): DeploymentRegistry {
  const reg = new DeploymentRegistry();
  const out = reg.register(DEPLOYMENT_ID, makeProfile());
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

/** A registry with the deployment registered but NO autonomy widened (default). */
function registryNotWidened(): DeploymentRegistry {
  const reg = new DeploymentRegistry();
  const out = reg.register(DEPLOYMENT_ID, makeProfile());
  if (!out.ok) throw new Error(`fixture profile rejected: ${out.offenders.join('; ')}`);
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
    // The merge gate is keyed off the deployment + a green, docs verdict.
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
  pulls: { merge: vi.fn(async () => ({ data: { merged: true } })) },
} as any;
const mockRuntime = { spawnSession: vi.fn() } as any;

/** Build handlers with the OPTIONAL registry threaded as the trailing param. */
function createHandlers(opts: {
  config?: Partial<Config>;
  registry?: DeploymentRegistry;
  decisionManager?: DecisionIndexManager;
  decisionPublisher?: GitHubBlockPublisher;
} = {}) {
  const config = makeConfig(opts.config);
  const mockCoordinator = { implement: vi.fn() } as any;
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

/** A decisionManager double mirroring the l2-gate decision-escalation tests. */
function makeDecisionDouble() {
  const raise = vi.fn().mockReturnValue({ decision_id: 'issue-42:integrate:1', outcome: 'admitted' });
  const notify = vi.fn().mockResolvedValue({ applied: true, status: 'notified' });
  const ensure = vi.fn().mockResolvedValue({ posted: true });
  const manager = {
    isEnabled: () => true,
    ledger: () => ({ raise, notify }),
  } as unknown as DecisionIndexManager;
  const publisher = { ensure } as unknown as GitHubBlockPublisher;
  return { manager, publisher, raise, notify, ensure };
}

describe('merge-decision live wiring — integrate handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseDetectLock();
    mockGit.mockResolvedValue({ ok: true, value: '' });
    // Default integrate result: a clean merge (so a wired "merge" path returns success).
    mockIntegrate.mockResolvedValue({
      ok: true,
      value: { success: true, conflicted: false, pushed: true },
    } as any);
    // In-scope docs touch → the auto lane stays in-scope.
    mockTouchedPaths.mockResolvedValue(['docs/readme.md']);
    // A present + runnable + falsifying verifier → the verifier gate passes, so the
    // decision turns on autonomy widening, not the gate.
    mockObserveVerifier.mockReturnValue({ observed: true, runnable: true, falsifying: true });
  });

  afterEach(() => {
    releaseDetectLock();
  });

  it('(a) deployment present, verifier-gated green lane, autonomy NOT widened → parks, raises a DecisionRequest, and does NOT merge', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, laneSet: {}, riskPathMap: [], defaultMinLevel: 'green', lifecycleMode: 'velocity', complianceReviewers: [] } },
      registry: registryNotWidened(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    // The safe-by-default arm: the run parks at integrate and escalates.
    expect(result).toBe('success');
    expect(run.pausedAtPhase).toBe('integrate');
    // It MUST NOT merge.
    expect(mockIntegrate).not.toHaveBeenCalled();
    // It raises a DecisionRequest for the parked merge decision (l2-gate pattern).
    expect(decision.raise).toHaveBeenCalledTimes(1);
    const req = decision.raise.mock.calls[0]?.[0] as { phase: string; decision_id: string };
    expect(req.phase).toBe('integrate');
  });

  it('(b) deployment present, verifier-gated green lane, autonomy WIDENED + validation passed → merges, no DecisionRequest', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, laneSet: {}, riskPathMap: [], defaultMinLevel: 'green', lifecycleMode: 'velocity', complianceReviewers: [] } },
      registry: registryWithWidenedGreen(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // The merge happens via the existing seam.
    expect(mockIntegrate).toHaveBeenCalledWith('feature/42', 'staging', expect.any(String));
    // No escalation: the run does not park, no DecisionRequest is raised.
    expect(run.pausedAtPhase).toBeUndefined();
    expect(decision.raise).not.toHaveBeenCalled();
  });

  it('(c) flag-OFF byte-identity: no config.deployment AND no registry → integrate merges unconditionally, no decision logic', async () => {
    const decision = makeDecisionDouble();
    // No deployment block, no registry param → today's behavior.
    const { handlers } = createHandlers({
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun({ deploymentId: undefined });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // Unconditional merge — byte-identical to pre-5b.
    expect(mockIntegrate).toHaveBeenCalledWith('feature/42', 'staging', expect.any(String));
    expect(run.pausedAtPhase).toBeUndefined();
    // No decision/observation/touched-path work runs on the flag-OFF path.
    expect(decision.raise).not.toHaveBeenCalled();
    expect(mockTouchedPaths).not.toHaveBeenCalled();
    expect(mockObserveVerifier).not.toHaveBeenCalled();
  });
});
