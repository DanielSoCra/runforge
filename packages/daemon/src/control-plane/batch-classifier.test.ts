import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CostTracker } from '../session-runtime/cost.js';
import { SessionError } from '../session-runtime/session-error.js';
import type { WorkRequest } from '../types.js';
import {
  buildBatchClassifierPrompt,
  classifyBatch,
  type BatchClassifierConfig,
} from './batch-classifier.js';

function makeWorkRequest(
  issueNumber: number,
  overrides: Partial<WorkRequest> = {},
): WorkRequest {
  return {
    issueNumber,
    title: `Issue ${issueNumber}`,
    body: `Body ${issueNumber}`,
    labels: ['ready'],
    specRefs: ['FUNC-AC-PIPELINE'],
    scopeDescription: 'Scope summary',
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<BatchClassifierConfig> = {},
): BatchClassifierConfig {
  return {
    maxBatchSize: 10,
    fallbackOnFailure: true,
    governanceContextFingerprint: undefined,
    ...overrides,
  };
}

function makeRuntime() {
  const costTracker = new CostTracker({ dailyBudget: 50, perRunBudget: 10 });
  const runtime = {
    spawnSession: vi.fn(),
    getCostTracker: vi.fn(() => costTracker),
  };
  const enqueueSpawnResult = (result: any) => {
    runtime.spawnSession.mockImplementationOnce(
      async (
        _type: string,
        _context: unknown,
        issueNumber: number,
        options?: { costAttributionIssueNumbers?: number[] },
      ) => {
        const cost = result.ok
          ? result.value.cost
          : result.error instanceof SessionError
            ? result.error.cost
            : 0;
        if (cost > 0) {
          const issueNumbers = options?.costAttributionIssueNumbers ?? [
            issueNumber,
          ];
          const perIssue = cost / issueNumbers.length;
          for (const costIssueNumber of issueNumbers) {
            costTracker.recordCost(costIssueNumber, perIssue);
          }
        }
        return result;
      },
    );
  };
  return { runtime, costTracker, enqueueSpawnResult };
}

describe('buildBatchClassifierPrompt (#470)', () => {
  it('renders stable governance prefix before variable work request data', () => {
    const prompt = buildBatchClassifierPrompt([
      { issueNumber: 1, workRequest: makeWorkRequest(1) },
      { issueNumber: 2, workRequest: makeWorkRequest(2) },
    ]);

    expect(prompt.indexOf('## Classification Criteria')).toBeGreaterThanOrEqual(
      0,
    );
    expect(prompt.indexOf('## Work Requests to Classify')).toBeGreaterThan(
      prompt.indexOf('## Classification Criteria'),
    );
    expect(prompt).toContain('<work-request index="1" issue-number="1">');
    expect(prompt).toContain('<work-request index="2" issue-number="2">');
  });
});

describe('classifyBatch (#470)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies multiple requests with one classifier session and proportional cost allocation', async () => {
    const { runtime, costTracker, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: [
          {
            issueNumber: 1,
            complexity: 'simple',
            reasoning: 'Small',
            estimatedUnits: 1,
            estimatedArtifacts: 1,
          },
          {
            issueNumber: 2,
            complexity: 'complex',
            reasoning: 'Cross-cutting',
            estimatedUnits: 6,
            estimatedArtifacts: 8,
          },
        ],
        cost: 0.2,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const cfg = makeConfig();
    const result = await classifyBatch(
      runtime as any,
      [
        { issueNumber: 1, workRequest: makeWorkRequest(1) },
        { issueNumber: 2, workRequest: makeWorkRequest(2) },
      ],
      cfg,
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
    const call = runtime.spawnSession.mock.calls[0]!;
    expect(call[0]).toBe('classifier');
    expect(call[1]).toEqual(
      expect.objectContaining({
        variables: expect.objectContaining({
          batchPrompt: expect.stringContaining('## Work Requests to Classify'),
        }),
      }),
    );
    expect(call[2]).toBe(1);
    expect(call[3]).toEqual(
      expect.objectContaining({
        jsonSchema: expect.any(String),
        costAttributionIssueNumbers: [1, 2],
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.results).toEqual([
      expect.objectContaining({
        issueNumber: 1,
        classified: true,
        event: 'success:simple',
        complexity: 'simple',
        allocatedCost: 0.1,
      }),
      expect.objectContaining({
        issueNumber: 2,
        classified: true,
        event: 'success',
        complexity: 'complex',
        allocatedCost: 0.1,
      }),
    ]);
    expect(costTracker.getRunCost(1)).toBe(0.1);
    expect(costTracker.getRunCost(2)).toBe(0.1);
    expect(cfg.governanceContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the same batch path for one request', async () => {
    const { runtime, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: [
          {
            issueNumber: 7,
            complexity: 'standard',
            reasoning: 'Several files',
            estimatedUnits: 3,
            estimatedArtifacts: 4,
          },
        ],
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classifyBatch(
      runtime as any,
      [{ issueNumber: 7, workRequest: makeWorkRequest(7) }],
      makeConfig(),
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({
      issueNumber: 7,
      classified: true,
      event: 'success',
      complexity: 'standard',
      allocatedCost: 0.05,
    });
  });

  it('falls back only for missing or invalid batch entries', async () => {
    const { runtime, costTracker, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: [
          {
            issueNumber: 1,
            complexity: 'standard',
            reasoning: 'Valid',
            estimatedUnits: 3,
            estimatedArtifacts: 4,
          },
          {
            issueNumber: 2,
            complexity: 'huge',
            reasoning: 'Invalid',
            estimatedUnits: 9,
            estimatedArtifacts: 9,
          },
        ],
        cost: 0.3,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Fallback result',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
        cost: 0.04,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classifyBatch(
      runtime as any,
      [
        { issueNumber: 1, workRequest: makeWorkRequest(1) },
        { issueNumber: 2, workRequest: makeWorkRequest(2) },
      ],
      makeConfig(),
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('partial');
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        issueNumber: 1,
        classified: true,
        complexity: 'standard',
        allocatedCost: 0.15,
      }),
    );
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        issueNumber: 2,
        classified: true,
        complexity: 'simple',
      }),
    );
    expect(result.results[1]?.allocatedCost).toBeCloseTo(0.04);
    expect(costTracker.getRunCost(1)).toBe(0.15);
    expect(costTracker.getRunCost(2)).toBe(0.19);
  });

  it('falls back individually when the batch session has a generic failure', async () => {
    const { runtime, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({ ok: false, error: new Error('batch failed') });
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Fallback 1',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'complex',
          reasoning: 'Fallback 2',
          estimatedUnits: 7,
          estimatedArtifacts: 9,
        },
        cost: 0.02,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classifyBatch(
      runtime as any,
      [
        { issueNumber: 1, workRequest: makeWorkRequest(1) },
        { issueNumber: 2, workRequest: makeWorkRequest(2) },
      ],
      makeConfig(),
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('partial');
    expect(result.results.map((r) => [r.issueNumber, r.complexity])).toEqual([
      [1, 'simple'],
      [2, 'complex'],
    ]);
  });

  it('does not fallback on safety signals from the batch session', async () => {
    const { runtime, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({
      ok: false,
      error: SessionError.rateLimited(0, 30_000),
    });

    const result = await classifyBatch(
      runtime as any,
      [{ issueNumber: 1, workRequest: makeWorkRequest(1) }],
      makeConfig(),
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
    expect(result.globalSignal).toBe('rate-limited');
    expect(result.results).toEqual([
      expect.objectContaining({
        issueNumber: 1,
        classified: false,
        event: 'rate-limited',
      }),
    ]);
  });

  it('falls back individually when the batch budget failure is per-run scoped', async () => {
    const { runtime, enqueueSpawnResult } = makeRuntime();
    enqueueSpawnResult({
      ok: false,
      error: SessionError.budgetExceeded('per-run-budget-exceeded'),
    });
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Fallback 1',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
        cost: 0.01,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });
    enqueueSpawnResult({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'standard',
          reasoning: 'Fallback 2',
          estimatedUnits: 3,
          estimatedArtifacts: 4,
        },
        cost: 0.02,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classifyBatch(
      runtime as any,
      [
        { issueNumber: 1, workRequest: makeWorkRequest(1) },
        { issueNumber: 2, workRequest: makeWorkRequest(2) },
      ],
      makeConfig(),
    );

    expect(runtime.spawnSession).toHaveBeenCalledTimes(3);
    expect(result.globalSignal).toBeUndefined();
    expect(result.results.map((r) => [r.issueNumber, r.event])).toEqual([
      [1, 'success:simple'],
      [2, 'success'],
    ]);
  });
});
