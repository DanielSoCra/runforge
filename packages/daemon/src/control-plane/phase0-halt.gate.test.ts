import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Phase, PhaseEvent, RunState } from '../types.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import type { ControlHandlers } from './server.js';
import type { PhaseHandlerMap } from './pipeline.js';
import type { StartDaemonOptions } from './daemon.js';
import type { StateManager } from './state.js';
import type { CostTracker } from '../session-runtime/cost.js';

const originalControlToken = process.env.AUTO_CLAUDE_CONTROL_TOKEN;
let serverRef: Server | undefined;

const daemonMockIds = [
  '../config.js',
  '../session-runtime/runtime.js',
  '../session-runtime/governance-context.js',
  '../session-runtime/providers/startup-admission.js',
  '../session-runtime/providers/smoke-test.js',
  '../session-runtime/adapters/index.js',
  '../session-runtime/managed-processes.js',
  '../session-runtime/cost.js',
  '../implementation/coordinator.js',
  './state.js',
  './server.js',
  './degraded-server.js',
  './startup-retry.js',
  './release.js',
  './repo-manager.js',
  './work-detection.js',
  './operator-retry.js',
  './phases.js',
  './phases-website.js',
  './agency-config.js',
  './pipeline.js',
  './phase-labels.js',
  './fsm.js',
  './variants.js',
  './notify.js',
  './watchdog.js',
  './health.js',
  './crash-handlers.js',
  './runtime-source.js',
  './remote-control.js',
  './workspace-bootstrap.js',
  './deployment-registry/index.js',
  './sanitization/build-pipeline.js',
  './decision-escalation/manager.js',
  './decision-escalation/config.js',
  './decision-escalation/build-request.js',
  './merge-decision/build-request.js',
  './decision-escalation/reconcile.js',
  './decision-api.js',
  './decision-escalation/answer-publisher.js',
  './finding-dismissal/tick.js',
  './decision-escalation/resume-consumer.js',
  './batch-classifier.js',
  './heartbeat.js',
  '@auto-claude/db',
  '../data/config-reader.js',
  '../data/run-writer.js',
  '../data/backend-kind.js',
  '../data/repo-source.js',
  '../data/run-history.js',
  '../knowledge/gotcha-store.js',
  '../knowledge/knowledge-store.js',
  '../knowledge/policy-registry.js',
  '../knowledge/maintenance.js',
  '../knowledge-sync/sync-service.js',
  '../knowledge/prompt-contracts.js',
  '../operator-learning/index.js',
  '../coordination/review-scheduler.js',
  '../coordination/po-agent.js',
  '../coordination/tech-lead-scheduler.js',
  '../coordination/coordinator.js',
  '../coordination/work-claimer.js',
  '../coordination/batch-manager.js',
  '../coordination/merge-agent.js',
  '../coordination/merge-queue.js',
  '../coordination/tech-lead/proposal-store.js',
  '../coordination/tech-lead/signal-digest.js',
  '../coordination/tech-lead/proposal-lifecycle.js',
  '../coordination/tech-lead/triage.js',
  '../coordination/tech-lead/finding-triage.js',
  '../coordination/tech-lead/triage-store.js',
  './po-snapshot.js',
  '../coordination/product-owner/shared-po-state.js',
  '../coordination/product-owner/interactive-session-context.js',
];

afterEach(async () => {
  if (serverRef) {
    const server = serverRef;
    serverRef = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (originalControlToken === undefined) {
    delete process.env.AUTO_CLAUDE_CONTROL_TOKEN;
  } else {
    process.env.AUTO_CLAUDE_CONTROL_TOKEN = originalControlToken;
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const id of daemonMockIds) vi.doUnmock(id);
  vi.resetModules();
});

// `halt` is not yet part of `ControlHandlers` (that's what G6 is gating on) —
// declared locally so the test can inject it without an `any` escape hatch.
type HaltHandler = () => Promise<{
  halted: boolean;
  parked: number[];
  terminated: number;
  escalated: number;
}>;

async function startControlServer(
  overrides: Partial<ControlHandlers> & { halt?: HaltHandler } = {},
) {
  const { createControlServer } = await import('./server.js');
  const handlers = {
    getStatus: () => ({ activeRuns: 0, paused: false }),
    pause: () => {},
    resume: () => {},
    drain: () => {},
    cancelDrain: () => {},
    retry: async () => ({ status: 404, body: { error: 'not found' } }),
    ...overrides,
  };
  const { server, start } = createControlServer(0, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
  return { server, port: (server.address() as AddressInfo).port };
}

const featureSimpleAllSuccess: PhaseHandlerMap = {
  detect: async () => 'success' as PhaseEvent,
  classify: async () => 'success:simple' as PhaseEvent,
  implement: async () => 'success' as PhaseEvent,
  review: async () => 'success' as PhaseEvent,
  holdout: async () => 'success' as PhaseEvent,
  integrate: async () => 'success' as PhaseEvent,
  deploy: async () => 'success' as PhaseEvent,
  test: async () => 'success' as PhaseEvent,
  report: async () => 'success' as PhaseEvent,
};

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: `run-${overrides.issueNumber ?? 200}`,
    issueNumber: overrides.issueNumber ?? 200,
    title: 'halt gate run',
    phase: 'implement',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true },
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

async function makePipelineDeps(prefix: string) {
  const [{ StateManager }, { CostTracker }] = await Promise.all([
    import('./state.js'),
    import('../session-runtime/cost.js'),
  ]);
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const stateMgr = new StateManager(dir);
  await stateMgr.initialize();
  const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
  return { stateMgr, costTracker };
}

async function runPipelineWithHalt(
  run: RunState,
  handlers: PhaseHandlerMap,
  isHalting: () => boolean,
  opts: { stateMgr?: StateManager; costTracker?: CostTracker; config?: unknown } = {},
) {
  const [{ runPipeline }, { getPipeline }] = await Promise.all([
    import('./pipeline.js'),
    import('./fsm.js'),
  ]);
  const deps =
    opts.stateMgr !== undefined && opts.costTracker !== undefined
      ? { stateMgr: opts.stateMgr, costTracker: opts.costTracker }
      : await makePipelineDeps('phase0-halt-pipeline-');
  const result = await (runPipeline as unknown as (
    run: RunState,
    table: unknown,
    handlers: PhaseHandlerMap,
    stateMgr: unknown,
    costTracker: unknown,
    config?: unknown,
    runWriter?: unknown,
    phaseLabelMirror?: unknown,
    isHalting?: () => boolean,
  ) => Promise<{ outcome: string; run: RunState; error?: string }>)(
    run,
    getPipeline(run.variant),
    handlers,
    deps.stateMgr,
    deps.costTracker,
    opts.config,
    undefined,
    undefined,
    isHalting,
  );
  return { result, stateMgr: deps.stateMgr };
}

async function loadPersistedRun(
  stateMgr: StateManager,
  issueNumber: number,
): Promise<RunState & { parkedBy?: 'halt' }> {
  const loaded = await stateMgr.loadRunState(issueNumber);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

function expectHaltPark(
  run: RunState & { parkedBy?: 'halt' },
  pausedAtPhase: Phase,
): void {
  expect(run.phase).toBe('paused');
  expect(run.pausedAtPhase).toBe(pausedAtPhase);
  expect(run.parkedBy).toBe('halt');
}

describe('phase0 halt gate: POST /halt', () => {
  it('returns the injected halted response with X-Requested-By', async () => {
    delete process.env.AUTO_CLAUDE_CONTROL_TOKEN;
    const halt = vi.fn().mockResolvedValue({
      halted: true,
      parked: [101, 102],
      terminated: 2,
      escalated: 1,
    });
    const { port } = await startControlServer({ halt });

    const res = await fetch(`http://127.0.0.1:${port}/halt`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'vitest' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      halted: true,
      parked: [101, 102],
      terminated: 2,
      escalated: 1,
    });
    expect(halt).toHaveBeenCalledOnce();
  });

  it('requires a Bearer token for /halt when AUTO_CLAUDE_CONTROL_TOKEN is set', async () => {
    process.env.AUTO_CLAUDE_CONTROL_TOKEN = 'phase0-secret';
    const halt = vi.fn().mockResolvedValue({
      halted: true,
      parked: [],
      terminated: 0,
      escalated: 0,
    });
    const { port } = await startControlServer({ halt });

    const missing = await fetch(`http://127.0.0.1:${port}/halt`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'vitest' },
    });
    const wrong = await fetch(`http://127.0.0.1:${port}/halt`, {
      method: 'POST',
      headers: {
        'X-Requested-By': 'vitest',
        Authorization: 'Bearer wrong-token',
      },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(403);
    expect(halt).not.toHaveBeenCalled();
  });
});

describe('phase0 halt gate: runPipeline halting interlock', () => {
  it('parks after a thrown phase failure without retrying or saving stuck', async () => {
    const run = makeRun({ issueNumber: 210, phase: 'implement' });
    const { stateMgr, costTracker } = await makePipelineDeps('phase0-halt-failure-');
    const saveSpy = vi.spyOn(stateMgr, 'saveRunState');
    let implementCalls = 0;
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => {
        implementCalls += 1;
        throw new Error('worker terminated during halt');
      },
      review: vi.fn(async () => 'success' as PhaseEvent),
    };

    const { result } = await runPipelineWithHalt(run, handlers, () => true, {
      stateMgr,
      costTracker,
    });
    const persisted = await loadPersistedRun(stateMgr, 210);

    expect(result.outcome).toBe('parked');
    expect(implementCalls).toBe(1);
    expect(handlers.review).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expectHaltPark(persisted, 'implement');
    expect(persisted.phase).not.toBe('stuck');
  });

  it('parks after a successful phase without advancing to the next phase', async () => {
    const run = makeRun({ issueNumber: 211, phase: 'implement' });
    let implementCalls = 0;
    const review = vi.fn(async () => 'success' as PhaseEvent);
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      implement: async () => {
        implementCalls += 1;
        return 'success' as PhaseEvent;
      },
      review,
    };

    const { result, stateMgr } = await runPipelineWithHalt(run, handlers, () => true);
    const persisted = await loadPersistedRun(stateMgr, 211);

    expect(result.outcome).toBe('parked');
    expect(implementCalls).toBe(1);
    expect(review).not.toHaveBeenCalled();
    expectHaltPark(persisted, 'implement');
    expect(persisted.phaseCompletions.implement).toBeUndefined();
  });

  it('parks before the missing-handler pre-flight save when halt is already active', async () => {
    const run = makeRun({ issueNumber: 212, phase: 'implement' });
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      review: undefined,
    };

    const { result, stateMgr } = await runPipelineWithHalt(run, handlers, () => true);
    const persisted = await loadPersistedRun(stateMgr, 212);

    expect(result.outcome).toBe('parked');
    expectHaltPark(persisted, 'implement');
    expect(persisted.phase).not.toBe('stuck');
  });

  it('parks before a budget-stop save when halt is already active', async () => {
    const run = makeRun({ issueNumber: 213, phase: 'review' });
    const { stateMgr, costTracker } = await makePipelineDeps('phase0-halt-budget-');
    costTracker.recordCost(213, 11);
    const review = vi.fn(async () => 'success' as PhaseEvent);
    const handlers: PhaseHandlerMap = {
      ...featureSimpleAllSuccess,
      review,
    };

    const { result } = await runPipelineWithHalt(run, handlers, () => true, {
      stateMgr,
      costTracker,
    });
    const persisted = await loadPersistedRun(stateMgr, 213);

    expect(result.outcome).toBe('parked');
    expect(review).not.toHaveBeenCalled();
    expectHaltPark(persisted, 'review');
    expect(persisted.phase).not.toBe('stuck');
  });
});

describe('phase0 halt gate: halt-parked resume', () => {
  it('re-admits halt-parked runs at their pausedAtPhase and clears halt park fields', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(process, 'on').mockImplementation(((
      _event: string,
      _handler: () => Promise<void>,
    ) => process) as never);
    vi.resetModules();
    const mocks = installDaemonResumeMocks();

    const reviewPark = makeDaemonParkedRun({
      id: 'halt-review',
      issueNumber: 301,
      pausedAtPhase: 'review',
      parkedBy: 'halt',
    });
    const integratePark = makeDaemonParkedRun({
      id: 'halt-integrate',
      issueNumber: 302,
      pausedAtPhase: 'integrate',
      parkedBy: 'halt',
    });
    mocks.state.findParkedRuns
      .mockResolvedValueOnce([reviewPark])
      .mockResolvedValueOnce([integratePark])
      .mockResolvedValue([]);

    const { startDaemon } = await import('./daemon.js');
    const boot = await startDaemon('config.json', {
      decisionManager: mocks.decisionManager,
    } satisfies StartDaemonOptions);
    expect(boot.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const saves = mocks.savedRuns;
    const reviewSave = saves.find((run) => run.issueNumber === 301);
    const integrateSave = saves.find((run) => run.issueNumber === 302);

    expect(reviewSave).toMatchObject({
      issueNumber: 301,
      phase: 'review',
    });
    // markers must be CLEARED after halt-resume; asserted via property access so
    // both `delete` and `= undefined` clearing satisfy it (the saveRunState mock
    // JSON-clones, which drops undefined-valued keys — toMatchObject with an
    // explicit undefined would demand the key exist and is unimplementable).
    expect(reviewSave?.pausedAtPhase).toBeUndefined();
    expect(reviewSave?.parkedBy).toBeUndefined();
    expect(integrateSave).toMatchObject({
      issueNumber: 302,
      phase: 'integrate',
    });
    expect(integrateSave?.pausedAtPhase).toBeUndefined();
    expect(integrateSave?.parkedBy).toBeUndefined();
    expect(mocks.runPipeline).toHaveBeenCalledTimes(2);
    expect((mocks.runPipeline.mock.calls[0]?.[0] as RunState).phase).toBe('review');
    expect((mocks.runPipeline.mock.calls[1]?.[0] as RunState).phase).toBe('integrate');
    expect(mocks.octokit.issues.get).not.toHaveBeenCalled();
  });
});

function makeDaemonParkedRun(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'halt-parked-run',
    issueNumber: 300,
    title: 'Halt parked run',
    phase: 'paused',
    pausedAtPhase: 'review',
    parkedBy: 'halt',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true, implement: true },
    checkpoints: [],
    cost: 1,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    body: 'resume from halt',
    labels: ['ready'],
    specRefs: [],
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function installDaemonResumeMocks() {
  const savedRuns: Array<Record<string, unknown>> = [];
  const loadConfig = vi.fn().mockResolvedValue(okResult(makeDaemonConfig()));
  const state = {
    initialize: vi.fn().mockResolvedValue(undefined),
    saveRunState: vi.fn().mockImplementation(async (run: Record<string, unknown>) => {
      savedRuns.push(JSON.parse(JSON.stringify(run)));
    }),
    findIncompleteRuns: vi.fn().mockResolvedValue([]),
    findParkedRuns: vi.fn().mockResolvedValue([]),
    findParkedRunsStrict: vi.fn().mockResolvedValue([]),
    deleteRunState: vi.fn().mockResolvedValue(undefined),
  };
  const detector = {
    detectReadyWork: vi.fn().mockResolvedValue(okResult([])),
    detectBugFixWork: vi.fn().mockResolvedValue(okResult(null)),
    detectFeaturePipelineWork: vi.fn().mockResolvedValue(okResult(null)),
    claimWork: vi.fn().mockResolvedValue(okResult(undefined)),
    claimBugFixWork: vi.fn().mockResolvedValue(okResult(undefined)),
    claimFeaturePipelineWork: vi.fn().mockResolvedValue(okResult(undefined)),
    markStuck: vi.fn().mockResolvedValue(okResult(undefined)),
  };
  const runPipeline = vi.fn().mockImplementation(async (run: RunState) => ({
    outcome: 'complete',
    run,
  }));
  const octokit = {
    issues: {
      get: vi.fn().mockResolvedValue({ data: { labels: [], state: 'open' } }),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      addLabels: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      createComment: vi.fn().mockResolvedValue(undefined),
    },
    pulls: {
      create: vi.fn().mockResolvedValue({ data: {} }),
      merge: vi.fn().mockResolvedValue({ data: {} }),
    },
  };
  const decisionManager = {
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn(() => false),
    isAvailable: vi.fn(() => false),
    isRuntimeDegraded: vi.fn(() => false),
    markRuntimeDegraded: vi.fn(),
    clearRuntimeDegraded: vi.fn(),
    protectedStore: vi.fn(() => undefined),
    ledger: vi.fn(() => {
      throw new Error('decision index disabled');
    }),
    revealProtected: vi.fn(),
  } as unknown as DecisionIndexManager;

  vi.doMock('../config.js', () => ({
    loadConfig,
    validateRequiredBootEnv: () => okResult(undefined),
    hasConfiguredAlertChannel: () => false,
  }));
  vi.doMock('../session-runtime/runtime.js', () => ({
    SessionRuntime: class {
      spawnSession = vi.fn();
      getProviderRegistry = () => ({
        markSmokeProof: vi.fn(),
        markSmokeFailed: vi.fn(),
      });
    },
    preloadPromptCache: async () => 0,
  }));
  vi.doMock('../session-runtime/governance-context.js', () => ({
    preloadGovernanceContext: async () => ({ sourcePath: 'test-governance' }),
  }));
  vi.doMock('../session-runtime/providers/startup-admission.js', () => ({
    admitProviders: vi.fn().mockResolvedValue({ aborted: false, abortReasons: [] }),
    buildCriticalChainByTier: vi.fn(() => []),
  }));
  vi.doMock('../session-runtime/providers/smoke-test.js', () => ({
    smokeTest: vi.fn().mockResolvedValue({ ok: true }),
  }));
  vi.doMock('../session-runtime/adapters/index.js', () => ({
    createProviderAdapter: vi.fn(() => ({
      capabilities: () => ({}),
      abort: vi.fn(),
      resume: vi.fn(),
      spawn: vi.fn(),
    })),
  }));
  vi.doMock('../session-runtime/managed-processes.js', () => ({
    killAllManagedProcessGroups: vi.fn(() => 0),
    terminateAllManagedProcessGroups: vi.fn().mockResolvedValue({
      terminated: 0,
      escalated: 0,
    }),
    managedProcessCount: vi.fn(() => 0),
    registerManagedProcess: vi.fn(),
    unregisterManagedProcess: vi.fn(),
    killProcessGroup: vi.fn(),
  }));
  vi.doMock('../session-runtime/cost.js', () => ({
    CostTracker: class {
      getDailyCost = vi.fn(() => 0);
      maybeResetDaily = vi.fn();
      checkBudget = vi.fn(() => ({ available: true }));
      getRunCost = vi.fn(() => 0);
      recordCost = vi.fn();
    },
  }));
  vi.doMock('../implementation/coordinator.js', () => ({
    ImplementationCoordinator: class {},
  }));
  vi.doMock('./state.js', () => ({
    StateManager: class {
      initialize = state.initialize;
      saveRunState = state.saveRunState;
      findIncompleteRuns = state.findIncompleteRuns;
      findParkedRuns = state.findParkedRuns;
      findParkedRunsStrict = state.findParkedRunsStrict;
      deleteRunState = state.deleteRunState;
    },
  }));
  vi.doMock('./server.js', () => ({
    createControlServer: vi.fn((_port: number, _handlers: unknown) => ({
      server: { close: (cb?: () => void) => cb?.() },
      start: vi.fn().mockResolvedValue(okResult(undefined)),
    })),
  }));
  vi.doMock('./degraded-server.js', () => ({
    createDegradedServer: vi.fn(() => ({
      start: vi.fn().mockResolvedValue(okResult(undefined)),
      handle: { close: vi.fn().mockResolvedValue(undefined) },
    })),
  }));
  vi.doMock('./startup-retry.js', () => ({
    runStartupRetry: vi.fn().mockResolvedValue({ kind: 'ok' }),
    readStartupRetryOptions: vi.fn(() => ({ maxAttempts: 1 })),
  }));
  vi.doMock('./release.js', () => ({
    createReleaseProposal: vi.fn().mockResolvedValue({ status: 'no-completed-work' }),
  }));
  vi.doMock('./work-detection.js', () => ({
    createWorkDetector: vi.fn(() => detector),
  }));
  vi.doMock('./operator-retry.js', () => ({
    retryStuckIssue: vi.fn().mockResolvedValue({
      status: 404,
      body: { error: 'not found' },
    }),
  }));
  vi.doMock('./phases.js', () => ({
    createPhaseHandlers: vi.fn(() => ({})),
  }));
  vi.doMock('./phases-website.js', () => ({
    createWebsitePhaseHandlers: vi.fn(() => ({})),
  }));
  vi.doMock('./agency-config.js', () => ({
    readAgencyConfig: vi.fn().mockResolvedValue({}),
  }));
  vi.doMock('./pipeline.js', () => ({
    runPipeline,
  }));
  vi.doMock('./phase-labels.js', () => ({
    createPhaseLabelMirror: vi.fn(() => ({
      applyPhaseLabel: vi.fn(),
      clearPhaseLabels: vi.fn(),
      provisionLabels: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  vi.doMock('./fsm.js', () => ({
    getPipeline: vi.fn(() => ({})),
    getStartPhase: vi.fn(() => 'detect'),
    isComplete: vi.fn(() => false),
  }));
  vi.doMock('./variants.js', () => ({
    selectVariant: vi.fn(() => 'feature-simple'),
  }));
  vi.doMock('./notify.js', () => ({
    notify: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./watchdog.js', () => ({
    createWatchdog: vi.fn(() => ({ tick: vi.fn().mockResolvedValue(undefined) })),
    readActiveRunProgress: vi.fn(() => []),
  }));
  vi.doMock('./health.js', () => ({
    evaluateHealth: vi.fn(() => ({ ok: true, degraded: false, reason: null })),
  }));
  vi.doMock('./crash-handlers.js', () => ({
    createCrashHandlers: vi.fn(() => ({
      onUncaughtException: vi.fn(),
      onUnhandledRejection: vi.fn(),
    })),
  }));
  vi.doMock('./runtime-source.js', () => ({
    buildRuntimeSourcePolicy: vi.fn(() => ({
      enabled: true,
      sourceRoot: '/repo',
      expectedRef: 'origin/main',
      requireClean: true,
      requireExpectedRef: true,
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    })),
    validateRuntimeSource: vi.fn().mockResolvedValue({
      enabled: true,
      healthy: true,
      sourceRoot: '/repo',
      currentRef: 'main',
      head: 'abc123',
      expectedRef: 'origin/main',
      clean: true,
      dirtyPaths: [],
      synchronized: true,
      checkedAt: '2026-07-02T00:00:00.000Z',
      action: 'pause',
    }),
  }));
  vi.doMock('./remote-control.js', () => ({
    RemoteControlManager: class {
      start = vi.fn();
      stop = vi.fn().mockResolvedValue(undefined);
      restart = vi.fn().mockResolvedValue(undefined);
      getState = vi.fn(() => ({}));
    },
  }));
  vi.doMock('./workspace-bootstrap.js', () => ({
    ensureWorkspaceRepo: vi.fn().mockResolvedValue(process.cwd()),
  }));
  vi.doMock('./deployment-registry/index.js', () => ({
    createDeploymentRegistry: vi.fn(() => ({
      register: vi.fn(() => ({ ok: true })),
      recordWidening: vi.fn(() => ({ ok: true })),
    })),
    JsonFileAutonomyStore: class {},
  }));
  vi.doMock('./sanitization/build-pipeline.js', () => ({
    buildSanitizationPipelineForDeployment: vi.fn(() => undefined),
  }));
  vi.doMock('./decision-escalation/manager.js', () => ({
    DecisionIndexManager: class {
      init = decisionManager.init;
      close = decisionManager.close;
      isEnabled = decisionManager.isEnabled;
      isAvailable = decisionManager.isAvailable;
      isRuntimeDegraded = decisionManager.isRuntimeDegraded;
      protectedStore = decisionManager.protectedStore;
      ledger = decisionManager.ledger;
    },
    markRuntimeDegradedIfGoverned: vi.fn(),
    clearRuntimeDegradedIfGoverned: vi.fn(),
  }));
  vi.doMock('./decision-escalation/config.js', () => ({
    readDecisionIndexConfig: vi.fn(() => ({})),
  }));
  vi.doMock('./decision-escalation/build-request.js', () => ({
    decisionIdFor: vi.fn((source: string, phase: string, epoch: number) => `${source}:${phase}:${epoch}`),
  }));
  vi.doMock('./merge-decision/build-request.js', () => ({
    decisionIdFor: vi.fn((source: string, epoch: number) => `${source}:integrate:${epoch}`),
  }));
  vi.doMock('./decision-escalation/reconcile.js', () => ({
    bootReconcile: vi.fn().mockResolvedValue(undefined),
    supersedeIfMoot: vi.fn().mockResolvedValue(undefined),
    markOverdue: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./decision-api.js', () => ({
    listPendingDecisions: vi.fn().mockResolvedValue({ status: 200, body: [] }),
    getDecisionDetail: vi.fn().mockResolvedValue({ status: 404, body: { error: 'not found' } }),
    answerDecision: vi.fn().mockResolvedValue({ status: 404, body: { error: 'not found' } }),
    revealProtected: vi.fn().mockResolvedValue({ status: 404, body: { error: 'not found' } }),
  }));
  vi.doMock('./decision-escalation/answer-publisher.js', () => ({
    postDecisionResponse: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./finding-dismissal/tick.js', () => ({
    runFindingDismissalTick: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('./decision-escalation/resume-consumer.js', () => ({
    parseCockpitAnswer: vi.fn(() => null),
    isDecisionOwnedIssue: vi.fn(() => false),
    REQUEUE_LABEL: 'ready',
  }));
  vi.doMock('./batch-classifier.js', () => ({
    classifyBatch: vi.fn().mockResolvedValue({
      results: [],
      totalCost: 0,
      batchSequenceId: 'batch',
      status: 'complete',
    }),
  }));
  vi.doMock('./heartbeat.js', () => ({
    startHeartbeat: vi.fn(() => vi.fn()),
  }));
  vi.doMock('@auto-claude/db', () => ({
    createDbClient: vi.fn(() => ({ db: {}, sql: { end: vi.fn().mockResolvedValue(undefined) } })),
    createPostgresStores: vi.fn(() => ({
      settings: {},
      repos: {},
      plugins: {},
      runs: {},
      costs: {},
      credentials: {},
    })),
    readCredentialKey: vi.fn(() => Buffer.alloc(32, 1)),
  }));
  vi.doMock('../data/config-reader.js', () => ({
    PostgresConfigReader: class {
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn();
      getGlobalConfig = vi.fn(() => null);
      getRepoConfig = vi.fn(() => null);
      tryFetch = vi.fn().mockResolvedValue(okResult(undefined));
      isStartupDegraded = vi.fn(() => false);
      getLastConfigError = vi.fn(() => null);
    },
  }));
  vi.doMock('../data/run-writer.js', () => ({
    PostgresRunWriter: class {
      insertRun = vi.fn().mockResolvedValue(undefined);
      upsertRun = vi.fn().mockResolvedValue(undefined);
      writeCostEvent = vi.fn().mockResolvedValue(undefined);
    },
    toDbOutcome: (outcome: string) => outcome,
  }));
  vi.doMock('../data/backend-kind.js', () => ({
    readDaemonDataBackendKind: vi.fn(() => 'postgres'),
  }));
  vi.doMock('../data/repo-source.js', () => ({
    PostgresRepoDataSource: class {
      listEnabledRepos = vi.fn().mockResolvedValue(okResult([
        {
          id: 'repo-id',
          owner: 'test-owner',
          name: 'test-repo',
          poll_interval_ms: null,
          connection_id: null,
        },
      ]));
      upsertRepo = vi.fn().mockResolvedValue(okResult('repo-id'));
      resolveConnectionToken = vi.fn().mockResolvedValue(undefined);
    },
  }));
  vi.doMock('../data/run-history.js', () => ({
    PostgresRunHistory: class {
      countStuckRunsForIssue = vi.fn().mockResolvedValue(0);
      markInProgressRunsStuck = vi.fn().mockResolvedValue(0);
    },
  }));
  vi.doMock('@octokit/rest', () => ({
    Octokit: class {
      issues = octokit.issues;
      pulls = octokit.pulls;
    },
  }));
  vi.doMock('../knowledge/gotcha-store.js', () => ({
    GotchaStore: class {},
  }));
  vi.doMock('../knowledge/knowledge-store.js', () => ({
    KnowledgeStore: class {},
  }));
  vi.doMock('../knowledge/policy-registry.js', () => ({
    DEFAULT_POLICIES: {},
  }));
  vi.doMock('../knowledge/maintenance.js', () => ({
    startKnowledgeMaintenance: vi.fn(() => ({ stop: vi.fn() })),
  }));
  vi.doMock('../knowledge-sync/sync-service.js', () => ({
    createKnowledgeSyncService: vi.fn(() => ({
      triggerSync: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  vi.doMock('../knowledge/prompt-contracts.js', () => ({
    validatePromptContracts: vi.fn().mockResolvedValue(okResult({ checked: 0 })),
  }));
  vi.doMock('../operator-learning/index.js', () => ({
    OperatorLearningService: class {
      init = vi.fn().mockResolvedValue(undefined);
      observeDecisionAnswer = vi.fn().mockResolvedValue(undefined);
      rankInboxItems = vi.fn((items: unknown[]) => items);
    },
  }));
  vi.doMock('../coordination/review-scheduler.js', () => ({
    createReviewScheduler: vi.fn(() => ({
      start: vi.fn(() => vi.fn()),
      getStatus: vi.fn(() => ({})),
    })),
  }));
  vi.doMock('../coordination/po-agent.js', () => ({
    createPOAgent: vi.fn(() => ({
      start: vi.fn(() => vi.fn()),
      submitIdea: vi.fn().mockResolvedValue({ id: 'idea-1' }),
    })),
  }));
  vi.doMock('../coordination/tech-lead-scheduler.js', () => ({
    createTechLeadScheduler: vi.fn(() => ({
      start: vi.fn(() => vi.fn()),
      stop: vi.fn(),
      triggerEvent: vi.fn(),
      getStatus: vi.fn(() => ({})),
    })),
  }));
  vi.doMock('../coordination/coordinator.js', () => ({
    createCoordinator: vi.fn(() => ({
      start: vi.fn(() => vi.fn()),
    })),
  }));
  vi.doMock('../coordination/work-claimer.js', () => ({
    createWorkClaimer: vi.fn(() => ({})),
  }));
  vi.doMock('../coordination/batch-manager.js', () => ({
    createBatchManager: vi.fn(() => ({})),
  }));
  vi.doMock('../coordination/merge-agent.js', () => ({
    createMergeAgent: vi.fn(() => ({})),
  }));
  vi.doMock('../coordination/merge-queue.js', () => ({
    createMergeQueue: vi.fn(() => ({})),
  }));
  vi.doMock('../coordination/tech-lead/proposal-store.js', () => ({
    TechProposalStore: class {
      init = vi.fn().mockResolvedValue(undefined);
      loadActiveProposals = vi.fn().mockResolvedValue([]);
      loadRejectedProposals = vi.fn().mockResolvedValue([]);
      loadAllProposals = vi.fn().mockResolvedValue([]);
      findDuplicate = vi.fn().mockResolvedValue(undefined);
      saveProposal = vi.fn().mockResolvedValue(undefined);
    },
  }));
  vi.doMock('../coordination/tech-lead/signal-digest.js', () => ({
    assembleSignalDigest: vi.fn().mockResolvedValue({
      id: 'digest-1',
      trigger: 'scheduled',
      reviewFindings: [],
      runOutcomes: [],
      driftIndicators: [],
      deferredWork: [],
      testHealth: [],
      dependencyRisks: [],
      activeProposals: [],
      priorRejections: [],
      missingSources: [],
      assembledAt: '2026-07-02T00:00:00.000Z',
    }),
  }));
  vi.doMock('../coordination/tech-lead/proposal-lifecycle.js', () => ({
    isTerminalStatus: vi.fn(() => false),
  }));
  vi.doMock('../coordination/tech-lead/triage.js', () => ({
    fetchUntriagedIssues: vi.fn().mockResolvedValue([]),
  }));
  vi.doMock('../coordination/tech-lead/finding-triage.js', () => ({
    applyTriageDecisions: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../coordination/tech-lead/triage-store.js', () => ({
    TriageStore: class {
      init = vi.fn().mockResolvedValue(undefined);
      remaining = vi.fn().mockResolvedValue(5);
      increment = vi.fn().mockResolvedValue(undefined);
    },
  }));
  vi.doMock('./po-snapshot.js', () => ({
    buildProductOwnerSessionVariables: vi.fn(() => ({})),
    buildProductOwnerSignalSnapshot: vi.fn().mockResolvedValue({
      activeProposals: [],
      backlog: '',
    }),
    PRODUCT_OWNER_SNAPSHOT_CONFIG: {},
  }));
  vi.doMock('../coordination/product-owner/shared-po-state.js', () => ({
    SharedPOStateStore: class {
      init = vi.fn().mockResolvedValue(undefined);
      loadIdeas = vi.fn().mockResolvedValue([]);
      loadProposals = vi.fn().mockResolvedValue([]);
    },
  }));
  vi.doMock('../coordination/product-owner/interactive-session-context.js', () => ({
    hasActiveInteractiveSession: vi.fn().mockResolvedValue(false),
    closeOrphanedSessions: vi.fn().mockResolvedValue(0),
    startInteractivePOSession: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        id: 'po-session-1',
        endReason: 'explicit_close',
        needsDiscussionResolved: 0,
        summary: '',
      },
    }),
  }));

  return { state, detector, runPipeline, octokit, decisionManager, savedRuns, loadConfig };
}

function okResult<T>(value: T) {
  return { ok: true as const, value };
}

function makeDaemonConfig(): Record<string, unknown> {
  return {
    controlPort: 3847,
    controlHost: '127.0.0.1',
    pollIntervalMs: 30_000,
    maxConcurrentRuns: 1,
    operatorReviewCategories: [],
    classifierBatchSize: 10,
    dailyBudget: 50,
    perRunBudget: 10,
    adapter: 'cli',
    autonomous: false,
    remoteControl: { enabled: false },
    runtimeSource: {
      enabled: true,
      requireClean: true,
      requireExpectedRef: true,
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    },
    branches: { staging: 'main', production: 'main' },
    webhooks: [],
    validation: {
      gate1Commands: [],
      maxFixCycles: 3,
      baselinePreexistingFailures: false,
      staticAnalysis: {
        maxComplexity: 15,
        maxFunctionLength: 50,
        maxFileSize: 500,
      },
      diminishingReturns: { minCycles: 2, improvementThreshold: 0.2 },
      healthCheckIntervalMs: 5_000,
      deployTimeoutMs: 120_000,
      maxDeployAttempts: 2,
      testCommands: [],
      maxTestFixAttempts: 3,
      failureExcerptLines: 50,
      proactiveIntervalMs: 1_200_000,
      proactiveMaxConcurrent: 1,
      proactiveThrottleThreshold: 0.8,
      proactiveRecentCommits: 20,
    },
    coordination: {
      useCoordinator: false,
      tickInterval: 5_000,
      maxAgents: 10,
      reviewerInterval: 3_600_000,
      poInterval: 3_600_000,
      poIdeaDebounce: 300_000,
      poFindingDailyCap: 5,
      poInteractiveTimeout: 1_800,
      poSharedStateRetentionDays: 7,
      poMaxWriteRetries: 3,
      plannerTimeout: 60_000,
      maxAttemptsPerIssue: 3,
      diskSpaceThreshold: 2_000_000_000,
      gcInterval: 600_000,
      conflictFileThreshold: 3,
      conflictLineThreshold: 100,
      mergeDependencyTimeout: 1_800_000,
      mergeValidationTimeout: 600_000,
      mergePollInterval: 5_000,
      mergePollMaxInterval: 60_000,
      techLeadInterval: 7_200_000,
      techLeadEventDebounce: 300_000,
      techLeadProposalExpiryMs: 604_800_000,
      techLeadLookbackWindowMs: 172_800_000,
      techLeadMaxEntriesPerSection: 50,
      triageDailyCap: 5,
      maxConsecutiveTickErrors: 5,
    },
    diagnosis: { confidenceThreshold: 0.7 },
    warmup: {
      threshold: 10,
      regressionThreshold: 3,
      samplingRate: 0.1,
      minSamplingRate: 0.01,
    },
    knowledge: {
      systemicProposalThreshold: 3,
      systemicProposalCooldownDays: 30,
      candidateTimeoutDays: 14,
      prospectiveSeverityThreshold: 5,
    },
    maxConsecutiveStuck: 3,
    gracePeriodMs: 100,
    maxRunsPerIssue: 3,
    retryBackoffBaseMs: 60_000,
    retryBackoffMaxMs: 1_800_000,
    governance: { documentPath: 'FACTORY_RULES.md', maxPrLinesChanged: 2000 },
    agentScopes: {},
    roleModels: {},
    activePlugins: [],
    repo: { owner: 'test-owner', name: 'test-repo' },
  };
}
