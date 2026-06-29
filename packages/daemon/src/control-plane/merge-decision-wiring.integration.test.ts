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
import {
  createFakeDecisionManager,
  asDecisionManager,
} from './decision-escalation/__fixtures__/fake-decision-ledger.js';

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
  // The governed-only runtime-degraded marker surface (PR1 first-use safety).
  const markRuntimeDegraded = vi.fn();
  const clearRuntimeDegraded = vi.fn();
  const isRuntimeDegraded = vi.fn(() => false);
  const manager = {
    isEnabled: () => true,
    isAvailable: () => true,
    ledger: () => ({ raise, notify }),
    markRuntimeDegraded,
    clearRuntimeDegraded,
    isRuntimeDegraded,
  } as unknown as DecisionIndexManager;
  const publisher = { ensure } as unknown as GitHubBlockPublisher;
  return {
    manager,
    publisher,
    raise,
    notify,
    ensure,
    markRuntimeDegraded,
    clearRuntimeDegraded,
    isRuntimeDegraded,
  };
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
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
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
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
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

  it('(d) deployment configured (id set) but NOT registered (profile rejected at boot) → fails CLOSED, does NOT merge', async () => {
    const decision = makeDecisionDouble();
    // A registry WITHOUT the deployment registered (its profile was rejected at
    // startup) while run.deploymentId is still set — the operator opted into
    // policy. This must NEVER fall through to the legacy unconditional merge.
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: new DeploymentRegistry(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    expect(result).toBe('failure');
    expect(mockIntegrate).not.toHaveBeenCalled();
  });

  it('(e) configured + non-auto decision but decision index DISABLED → fails CLOSED, no silent park, no merge', async () => {
    // registry present (configured, not widened) but NO decisionManager → there is
    // no surface to escalate to. The run must fail closed, not silently park and
    // not merge.
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(),
      // decisionManager omitted → isEnabled() !== true
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    expect(result).toBe('failure');
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBeUndefined(); // no silent park
  });

  it('(f) deployment found but does NOT own the run repo → fails CLOSED (no foreign profile, no merge)', async () => {
    const reg = new DeploymentRegistry();
    // Registered under DEPLOYMENT_ID but owning a DIFFERENT repo than the run's.
    const out = reg.register(DEPLOYMENT_ID, {
      ...makeProfile(),
      repositories: [{ owner: 'other', name: 'elsewhere' }],
    });
    expect(out.ok).toBe(true);
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: reg,
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun(); // run is for owner/repo, which this profile does NOT own

    const result = await handlers.integrate!(run);

    expect(result).toBe('failure');
    expect(mockIntegrate).not.toHaveBeenCalled();
  });

  it('(g) a compliance reviewer governing a touched path forces escalation, even when widened', async () => {
    const reg = new DeploymentRegistry();
    // A compliance reviewer governs docs/** — and the (mocked) touched path is
    // docs/readme.md. Green is widened, verifier good, in-scope → WITHOUT the
    // compliance lens this would auto-merge; the lens must override and escalate.
    const out = reg.register(DEPLOYMENT_ID, {
      ...makeProfile(),
      complianceReviewers: [{ reviewer: 'clinical-lead', condition: 'docs/**' }],
    });
    expect(out.ok).toBe(true);
    reg.recordWidening(
      DEPLOYMENT_ID,
      'green',
      'widened',
      { kind: 'operator-grant', operator: 'daniel' },
      1,
    );
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: reg,
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    await handlers.integrate!(run);

    expect(mockIntegrate).not.toHaveBeenCalled(); // compliance overrides autonomy
    expect(run.pausedAtPhase).toBe('integrate');
    expect(decision.raise).toHaveBeenCalled();
  });

  it('(g2) a STATIC deployment-profile PASS verdict does NOT auto-merge a regulated change — it ESCALATES (fail-closed, #779)', async () => {
    const reg = new DeploymentRegistry();
    // Same governed docs/** path as (g). The deployment ALSO declares a recorded
    // compliance verdict on its FROZEN profile: clinical-lead PASSED. That verdict
    // is DEPLOYMENT-scoped, not CHANGE-scoped — a single historic pass must NOT
    // clear the gate for THIS (or any future) change touching governed paths.
    // SECURITY (#779): the integrate handler deliberately does NOT source static
    // profile verdicts, so the lens fails closed via path matching and the change
    // ESCALATES even though a static `pass` is on record and autonomy is widened.
    const out = reg.register(DEPLOYMENT_ID, {
      ...makeProfile(),
      complianceReviewers: [{ reviewer: 'clinical-lead', condition: 'docs/**' }],
      complianceVerdicts: [
        {
          reviewerRoleId: 'clinical-lead',
          verdict: 'pass',
          reason: 'reviewed',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(out.ok).toBe(true);
    reg.recordWidening(
      DEPLOYMENT_ID,
      'green',
      'widened',
      { kind: 'operator-grant', operator: 'daniel' },
      1,
    );
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: reg,
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    await handlers.integrate!(run);

    // Static profile pass must NOT clear the change-scoped gate.
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBe('integrate');
    expect(decision.raise).toHaveBeenCalled();
  });

  it('(g3) a regulated change escalates even when a static BLOCK verdict is on record (still fail-closed, never merges)', async () => {
    // NOTE (#779): post-fix, escalation here is driven by the fail-closed
    // path-condition match (static profile verdicts are not sourced), so a static
    // BLOCK can never be mistaken for a "merge anyway" signal either. The change
    // still must NOT merge — this guards that the block case stays escalating.
    const reg = new DeploymentRegistry();
    const out = reg.register(DEPLOYMENT_ID, {
      ...makeProfile(),
      complianceReviewers: [{ reviewer: 'clinical-lead', condition: 'docs/**' }],
      complianceVerdicts: [
        {
          reviewerRoleId: 'clinical-lead',
          verdict: 'block',
          reason: 'non-compliant',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(out.ok).toBe(true);
    reg.recordWidening(
      DEPLOYMENT_ID,
      'green',
      'widened',
      { kind: 'operator-grant', operator: 'daniel' },
      1,
    );
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: reg,
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    await handlers.integrate!(run);

    expect(mockIntegrate).not.toHaveBeenCalled(); // block overrides autonomy
    expect(run.pausedAtPhase).toBe('integrate');
    expect(decision.raise).toHaveBeenCalled();
  });

  // --- operator-approved resume override (follow-up #9) ---------------------
  // After the resume branch sets run.mergeDecisionApprovedEpoch on an operator
  // APPROVE, a run re-entering integrate must MERGE (execute the held merge) via
  // the override — NOT re-park — even though autonomy is NOT widened (the operator
  // decided manually). The override is epoch-keyed + one-shot.
  it('(h) operator-approved resume (mergeDecisionApprovedEpoch === mergeDecisionEpoch) MERGES instead of re-parking, even when autonomy NOT widened', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      // NOT widened → decideMerge returns escalate/hold; WITHOUT the override this
      // run would re-park. The operator-approved override must merge it anyway.
      registry: registryNotWidened(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    // The resume branch set the approved epoch to the current park epoch.
    const run = makeRun({ mergeDecisionEpoch: 1, mergeDecisionApprovedEpoch: 1 });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // The held merge executes via the existing seam — the operator approved it.
    expect(mockIntegrate).toHaveBeenCalledWith('feature/42', 'staging', expect.any(String));
    // It MUST NOT re-park nor re-raise a DecisionRequest.
    expect(run.pausedAtPhase).toBeUndefined();
    expect(decision.raise).not.toHaveBeenCalled();
    // One-shot: the override is cleared after a successful operator-approved merge
    // so a later re-entry cannot re-consume it.
    expect(run.mergeDecisionApprovedEpoch).toBeUndefined();
  });

  it('(i) one-shot/epoch: a STALE mergeDecisionApprovedEpoch (≠ current mergeDecisionEpoch) does NOT merge — it re-parks/escalates', async () => {
    const decision = makeDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    // Current epoch is 2 (a fresh park) but the approved flag is for a prior
    // epoch (1) — a stale, already-consumed approval. It must NOT authorize a merge.
    const run = makeRun({ mergeDecisionEpoch: 2, mergeDecisionApprovedEpoch: 1 });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    // No merge: the stale approval is ignored, the run re-parks for a fresh decision.
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(run.pausedAtPhase).toBe('integrate');
    expect(decision.raise).toHaveBeenCalled();
    // The stale flag is left untouched (NOT cleared) — only a matching epoch consumes.
    expect(run.mergeDecisionApprovedEpoch).toBe(1);
  });

  // --- governed-only runtime-degraded marking (PR1 first-use safety, T1.2) ----
  // The integrate handler is the merge-decision approval path; for a GOVERNED run
  // an approval-path failure marks the index runtime-degraded (observable at
  // /health) without changing the existing fail-closed control flow. The marker is
  // cleared ONLY by a successful governed decision-index op that proves the
  // approval TRANSPORT recovered (a successful raise+notify in publish) — NOT by a
  // successful Git merge (which never touches the ledger), and never by a
  // non-governed op.

  /** A manager double that is enabled but UNREACHABLE at runtime (isAvailable=false). */
  function makeUnavailableDecisionDouble() {
    const markRuntimeDegraded = vi.fn();
    const clearRuntimeDegraded = vi.fn();
    const manager = {
      isEnabled: () => true,
      isAvailable: () => false,
      ledger: () => {
        throw new Error('decision index unavailable');
      },
      markRuntimeDegraded,
      clearRuntimeDegraded,
      isRuntimeDegraded: () => false,
    } as unknown as DecisionIndexManager;
    return { manager, markRuntimeDegraded, clearRuntimeDegraded };
  }

  it('(marker-floor) governed run + escalate decision + index UNAVAILABLE → marks runtime-degraded, fails closed (no merge, no park)', async () => {
    const decision = makeUnavailableDecisionDouble();
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(), // escalate decision
      decisionManager: decision.manager,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    // Existing fail-closed flow is UNCHANGED: the floor returns 'failure'.
    expect(result).toBe('failure');
    expect(mockIntegrate).not.toHaveBeenCalled();
    // The new side-effect: the governed run marked the index runtime-degraded.
    expect(decision.markRuntimeDegraded).toHaveBeenCalledTimes(1);
    expect(decision.clearRuntimeDegraded).not.toHaveBeenCalled();
  });

  it('(marker-publish) governed run + ledger.raise throws → marks runtime-degraded, stays parked (fail-closed)', async () => {
    const decision = makeDecisionDouble();
    decision.raise.mockImplementation(() => {
      throw new Error('ledger raise boom (postgres down)');
    });
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(),
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    // The run parks (control flow unchanged) and never merges.
    expect(result).toBe('success');
    expect(run.pausedAtPhase).toBe('integrate');
    expect(mockIntegrate).not.toHaveBeenCalled();
    // The raise() failure marked the index runtime-degraded for the governed run.
    expect(decision.markRuntimeDegraded).toHaveBeenCalledTimes(1);
    expect(decision.clearRuntimeDegraded).not.toHaveBeenCalled();
  });

  it('(marker-clear-on-publish) governed park: a successful raise+notify CLEARS the runtime-degraded marker (transport recovered)', async () => {
    const decision = makeDecisionDouble(); // raise/notify succeed, publish posts
    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(), // escalate → parks → raise + publish + notify
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun();

    const result = await handlers.integrate!(run);

    // Parks (control flow unchanged), never merges.
    expect(result).toBe('success');
    expect(run.pausedAtPhase).toBe('integrate');
    expect(mockIntegrate).not.toHaveBeenCalled();
    expect(decision.raise).toHaveBeenCalledTimes(1);
    expect(decision.notify).toHaveBeenCalledTimes(1);
    // A successful raise+notify is a successful governed DECISION-INDEX op → clear.
    expect(decision.clearRuntimeDegraded).toHaveBeenCalledTimes(1);
    expect(decision.markRuntimeDegraded).not.toHaveBeenCalled();
  });

  it('(marker-regression Finding-1) governed operator-approved merge SUCCEEDS but the index is still degraded → the merge does NOT clear the marker', async () => {
    // Models the bug: resumeIntegrateParkedRun marked the index degraded when
    // advanceToResumed() failed, then the run re-entered integrate merge-armed.
    // A successful Git merge must NOT erase that real index-transport failure.
    const { manager } = createFakeDecisionManager(); // tracks REAL marker state
    manager.markRuntimeDegraded('advanceToResumed failed earlier');
    expect(manager.isRuntimeDegraded()).toBe(true);

    const { handlers } = createHandlers({
      config: { deployment: { id: DEPLOYMENT_ID, profile: {} } },
      registry: registryNotWidened(),
      decisionManager: asDecisionManager(manager),
    });
    // Operator-approved override (epoch-matched) → the held merge executes — and
    // this path never touches the ledger, so it cannot prove transport recovery.
    const run = makeRun({ mergeDecisionEpoch: 1, mergeDecisionApprovedEpoch: 1 });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    expect(mockIntegrate).toHaveBeenCalled(); // the merge DID succeed
    // ...but the runtime-degraded marker is STILL set (merge success ≠ index health).
    expect(manager.isRuntimeDegraded()).toBe(true);
    expect(manager.degradedClears).toBe(0);
  });

  it('(marker-clear-boundary) NON-governed merge success does NOT clear the marker (clear is governed-only)', async () => {
    const decision = makeDecisionDouble();
    // No config.deployment + run.deploymentId undefined → non-governed unconditional merge.
    const { handlers } = createHandlers({
      decisionManager: decision.manager,
      decisionPublisher: decision.publisher,
    });
    const run = makeRun({ deploymentId: undefined });

    const result = await handlers.integrate!(run);

    expect(result).toBe('success');
    expect(mockIntegrate).toHaveBeenCalled();
    // The clear is governed-only: a non-governed success must NOT clear a marker a
    // governed failure may have set.
    expect(decision.clearRuntimeDegraded).not.toHaveBeenCalled();
    expect(decision.markRuntimeDegraded).not.toHaveBeenCalled();
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
