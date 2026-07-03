// G3: gates decision-raised operator alerts on applied notify transitions only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { DecisionRequest } from '@auto-claude/decision-protocol';
import type { Config } from '../config.js';
import type { ImplementationCoordinator } from '../implementation/coordinator.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { RunState, WorkRequest } from '../types.js';
import type { DeploymentRegistry } from './deployment-registry/registry.js';
import type { DecisionIndexManager } from './decision-escalation/manager.js';
import type { GitHubBlockPublisher } from './decision-escalation/github-block-notifier.js';
import type { OctokitLike as PublisherOctokit } from './decision-escalation/github-block-notifier.js';
import type { NotificationPayload } from './notify.js';
import {
  emitFindingDismissalDecision,
  type EmitLedger,
  type EmitLearning,
  type EmitPublisher,
} from './finding-dismissal/emit.js';

vi.mock('./merge-decision/index.js', () => ({
  buildMergeDecisionRequest: vi.fn(
    (run: { issueNumber?: unknown }, epoch: number): Record<string, unknown> => {
      const issueNumber =
        typeof run.issueNumber === 'number' ? run.issueNumber : 0;
      const decisionId = `issue-${issueNumber}:integrate:${epoch}`;
      return {
        decision_id: decisionId,
        source_url: `https://github.com/owner/repo/issues/${issueNumber}`,
        deployment: 'deployment-1',
        run_id: `issue-${issueNumber}`,
        worker_session_id: `run-${issueNumber}`,
        phase: 'integrate',
        risk_class: 'P1',
        question: `Approve merge for issue #${issueNumber}?`,
        context: 'Merge decision context',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        consequence_of_no_answer: 'The run remains parked.',
        reversibility: 'reversible',
        expires_at: '2026-07-09T00:00:00.000Z',
        answer_schema: { kind: 'option' },
        resume_mode: 'requeue',
        idempotency_key: decisionId,
      };
    },
  ),
  computeTouchedPaths: vi.fn(async () => ['src/example.ts']),
  decideMerge: vi.fn(() => ({
    kind: 'hold',
    reason: 'awaiting-independent-review',
    effectiveRisk: 'yellow',
  })),
  evaluateComplianceForced: vi.fn(() => false),
  observeVerifierStatus: vi.fn(() => ({ status: 'runnable' })),
}));

vi.mock('./lane-engine/index.js', () => ({
  assignLane: vi.fn(() => ({ lane: 'review' })),
  gateSetVerdict: vi.fn(() => true),
  resolveForMode: vi.fn((laneSet: unknown) => laneSet),
}));

import { createPhaseHandlers } from './phases.js';

type NotifyTransitionResult = { applied: boolean; status: string };
type DecisionRaisedPayload = NotificationPayload & {
  event: 'decision-raised';
  decisionId?: string;
  url?: string;
};
type AlertCallback = (payload: DecisionRaisedPayload) => void | Promise<void>;

const DECISION_RAISED_SCHEMA_PROBE = {
  event: 'decision-raised',
  issueNumber: 42,
  message: 'Decision raised',
  decisionId: 'issue-42:l2-gate:1',
  url: 'https://dashboard.example.test/steering',
} satisfies DecisionRaisedPayload;
void DECISION_RAISED_SCHEMA_PROBE;

const createPhaseHandlersWithAlert = createPhaseHandlers as unknown as (
  ...args: unknown[]
) => ReturnType<typeof createPhaseHandlers>;

const emitFindingDismissalDecisionWithAlert =
  emitFindingDismissalDecision as unknown as (
    ...args: unknown[]
  ) => ReturnType<typeof emitFindingDismissalDecision>;

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
      onUnhealthy: 'pause',
      ignoredDirtyPaths: ['state/'],
    },
    branches: { staging: 'staging', production: 'main' },
    webhooks: ['https://alerts.example.test/hook'],
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

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'test-run',
    issueNumber: 42,
    title: 'Test issue',
    phase: 'l2-gate',
    variant: 'feature-simple',
    phaseCompletions: { detect: true, classify: true },
    checkpoints: [],
    cost: 1.5,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    repoOwner: 'owner',
    repoName: 'repo',
    ...overrides,
  };
}

function makeWorkRequest(): WorkRequest {
  return {
    issueNumber: 42,
    title: 'Test issue',
    body: 'Build a governed change',
    labels: ['ready'],
    specRefs: [],
  };
}

function makeOctokit(labels: string[] = ['ready']): Octokit {
  return {
    issues: {
      get: vi.fn(async () => ({
        data: {
          labels: labels.map((name) => ({ name })),
          body: 'Issue body',
        },
      })),
      addLabels: vi.fn(async () => ({})),
      createComment: vi.fn(async () => ({})),
      listComments: vi.fn(async () => ({ data: [] })),
      removeLabel: vi.fn(async () => ({})),
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
}

function makeDecisionPublisher(): GitHubBlockPublisher {
  return {
    ensure: vi.fn(async (_args: unknown) => ({ posted: true })),
  } as unknown as GitHubBlockPublisher;
}

function decisionIdFromRequest(rawRequest: unknown, fallback: string): string {
  if (typeof rawRequest === 'object' && rawRequest !== null) {
    const decisionId = (rawRequest as { decision_id?: unknown }).decision_id;
    if (typeof decisionId === 'string' && decisionId.length > 0) {
      return decisionId;
    }
  }
  return fallback;
}

function makeDecisionManager(
  notifyResult: NotifyTransitionResult,
  fallbackDecisionId: string,
): DecisionIndexManager {
  const raise = vi.fn(async (rawRequest: unknown) => ({
    decision_id: decisionIdFromRequest(rawRequest, fallbackDecisionId),
    outcome: 'admitted' as const,
  }));
  const notify = vi.fn(async (_decisionId: string) => notifyResult);
  const ledger = { raise, notify };

  return {
    isEnabled: () => true,
    isAvailable: () => true,
    ledger: () => ledger,
    markRuntimeDegraded: vi.fn(),
    clearRuntimeDegraded: vi.fn(),
    isRuntimeDegraded: () => false,
  } as unknown as DecisionIndexManager;
}

function makeRegistry(): DeploymentRegistry {
  return {
    resolveLaneEngineInputs: () => ({
      kind: 'found',
      inputs: {
        laneSet: {
          lanes: [{ name: 'review', verifier: { ref: 'ci' } }],
          mostCautiousLane: 'review',
        },
        riskPathMap: {},
        defaultMinLevel: 'yellow',
        mode: 'pilot',
      },
    }),
    ownsRepo: () => true,
    readAutonomyState: () => [],
    readDeclaredData: (deploymentId: string, which: string) => {
      if (which === 'landing') {
        return {
          kind: 'found',
          which: 'landing',
          value: { landsOn: 'main', productionReleasePath: { kind: 'trigger-automated', trigger: 'tag-and-deploy' }, requiredChecks: ['ci'] },
        };
      }
      return { kind: 'not-found', deploymentId };
    },
  } as unknown as DeploymentRegistry;
}

function makePhaseHandlers(
  notifyResult: NotifyTransitionResult,
  alert: AlertCallback,
  registry?: DeploymentRegistry,
): ReturnType<typeof createPhaseHandlers> {
  return createPhaseHandlersWithAlert(
    makeConfig(),
    'owner',
    'repo',
    { spawnSession: vi.fn() } as unknown as SessionRuntime,
    { implement: vi.fn() } as unknown as ImplementationCoordinator,
    makeOctokit(),
    makeWorkRequest(),
    '/tmp/state',
    undefined,
    undefined,
    '/tmp/repo',
    undefined,
    undefined,
    undefined,
    makeDecisionManager(notifyResult, 'issue-42:l2-gate:1'),
    makeDecisionPublisher(),
    registry,
    undefined,
    undefined,
    undefined,
    alert,
  );
}

function expectDecisionRaisedPayload(
  payload: unknown,
  issueNumber: number,
): asserts payload is DecisionRaisedPayload {
  expect(payload).toMatchObject({
    event: 'decision-raised',
    issueNumber,
    message: expect.any(String),
  });
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('expected decision-raised notification payload');
  }
  const optional = payload as { decisionId?: unknown; url?: unknown };
  if (optional.decisionId !== undefined) {
    expect(optional.decisionId).toBeTypeOf('string');
  }
  if (optional.url !== undefined) {
    expect(optional.url).toBeTypeOf('string');
  }
}

async function exerciseL2Gate(
  notifyResult: NotifyTransitionResult,
  alert: AlertCallback,
): Promise<void> {
  const handlers = makePhaseHandlers(notifyResult, alert);
  const phase = handlers['l2-gate'];
  expect(phase, 'l2-gate handler must exist').toBeTypeOf('function');
  const result = await phase!(makeRun({ phase: 'l2-gate' }));
  expect(result).toBe('success');
}

async function exerciseIntegrate(
  notifyResult: NotifyTransitionResult,
  alert: AlertCallback,
): Promise<void> {
  const handlers = makePhaseHandlers(notifyResult, alert, makeRegistry());
  const phase = handlers.integrate;
  expect(phase, 'integrate handler must exist').toBeTypeOf('function');
  const result = await phase!(
    makeRun({
      phase: 'integrate',
      deploymentId: 'deployment-1',
      classificationComplexity: 'standard',
      passedGates: ['deterministic'],
    }),
  );
  expect(result).toBe('success');
}

function makeEmitLedger(notifyResult: NotifyTransitionResult): EmitLedger {
  const decisionId = 'finding-owner/repo#77:finding-dismissal:correctness:1';
  return {
    statusOf: vi.fn(async () => undefined),
    recommendedOptionOf: vi.fn(async () => null),
    raise: vi.fn(async (_rawRequest: unknown) => ({
      decision_id: decisionId,
      outcome: 'admitted' as const,
    })),
    notify: vi.fn(async (_id: string) => notifyResult),
  };
}

const surfaceLearning: EmitLearning = {
  getPreference: async () => ({ rung: 'surface', confidence: 0 }),
};

function makeEmitPublisher(): EmitPublisher {
  return {
    ensure: vi.fn(async (_args: {
      request: DecisionRequest;
      octokit: PublisherOctokit;
      owner: string;
      repo: string;
      issueNumber: number;
    }) => ({ posted: true })),
  };
}

async function exerciseFindingDismissal(
  notifyResult: NotifyTransitionResult,
  alert: AlertCallback,
): Promise<void> {
  await emitFindingDismissalDecisionWithAlert(
    {
      ledger: makeEmitLedger(notifyResult),
      operatorLearning: surfaceLearning,
      publisher: makeEmitPublisher(),
      octokit: {} as unknown as PublisherOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 77,
      category: 'correctness',
      riskClass: 'P1',
      labels: ['review-finding', 'correctness', 'P2'],
    },
    alert,
  );
}

const seams = [
  { name: 'l2-gate seam', issueNumber: 42, exercise: exerciseL2Gate },
  { name: 'merge-park seam', issueNumber: 42, exercise: exerciseIntegrate },
  {
    name: 'finding-dismissal seam',
    issueNumber: 77,
    exercise: exerciseFindingDismissal,
  },
] as const;

describe('G3 decision-raised alert acceptance gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const seam of seams) {
    it(`${seam.name}: applied notify sends exactly one decision-raised payload`, async () => {
      const alert = vi.fn<AlertCallback>(async (_payload) => undefined);

      await seam.exercise({ applied: true, status: 'notified' }, alert);

      expect(alert).toHaveBeenCalledTimes(1);
      expectDecisionRaisedPayload(alert.mock.calls[0]?.[0], seam.issueNumber);
    });

    it(`${seam.name}: notify no-op does not alert`, async () => {
      const alert = vi.fn<AlertCallback>(async (_payload) => undefined);

      await seam.exercise({ applied: false, status: 'notified' }, alert);

      expect(alert).not.toHaveBeenCalled();
    });

    it(`${seam.name}: alert failure does not propagate out of raise-and-notify`, async () => {
      const alert = vi.fn<AlertCallback>(async (_payload) => {
        throw new Error('webhook rejected');
      });

      await expect(
        seam.exercise({ applied: true, status: 'notified' }, alert),
      ).resolves.toBeUndefined();
      expect(alert).toHaveBeenCalledTimes(1);
    });
  }
});
