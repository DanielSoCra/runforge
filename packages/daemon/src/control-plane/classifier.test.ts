import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classify } from './classifier.js';
import { SessionError } from '../session-runtime/session-error.js';

const mockRuntime = {
  spawnSession: vi.fn(),
} as any;

function makeWorkRequest() {
  return {
    issueNumber: 42,
    title: 'Test issue',
    body: 'Fix something',
    labels: ['ready'],
    specRefs: ['FUNC-AC-PIPELINE'],
    scopeDescription: 'Single file fix',
  };
}

describe('classify (#145)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns a classifier session and returns success:simple for simple classification', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Single file, no cross-cutting',
          estimatedUnits: 1,
          estimatedArtifacts: 2,
        },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success:simple');
    expect(result.complexity).toBe('simple');
    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'classifier',
      expect.objectContaining({
        variables: expect.objectContaining({
          specRefs: 'FUNC-AC-PIPELINE',
          scope: 'Single file fix',
        }),
      }),
      42,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });

  it('returns success for standard classification', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'standard',
          reasoning: 'Multiple units needed',
          estimatedUnits: 3,
          estimatedArtifacts: 5,
        },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success');
    expect(result.complexity).toBe('standard');
  });

  it('returns success for complex classification', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'complex',
          reasoning: 'Cross-cutting architectural change',
          estimatedUnits: 8,
          estimatedArtifacts: 15,
        },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success');
    expect(result.complexity).toBe('complex');
  });

  it('falls back to success:simple with no complexity when session fails with generic Error', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: false,
      error: new Error('Some generic failure'),
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success:simple');
    expect(result.complexity).toBeUndefined();
  });

  it('returns budget-exceeded when session fails with SessionError.budgetExceeded (#265)', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: false,
      error: SessionError.budgetExceeded('daily-budget-exceeded'),
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('budget-exceeded');
    expect(result.complexity).toBeUndefined();
  });

  it('returns rate-limited when session fails with SessionError.rateLimited (#265)', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: false,
      error: SessionError.rateLimited(0.5, 30000),
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('rate-limited');
    expect(result.complexity).toBeUndefined();
  });

  it('returns containment-breach when session fails with SessionError.containmentBreached (#265)', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: false,
      error: SessionError.containmentBreached('shell escape detected', 0.3),
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('containment-breach');
    expect(result.complexity).toBeUndefined();
  });

  it('falls back to success:simple with no complexity when output is invalid', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: 'garbage output',
        structuredData: { invalid: true },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success:simple');
    expect(result.complexity).toBeUndefined();
  });

  it('uses "none" for empty specRefs and default scope', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Trivial',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const workReq = makeWorkRequest();
    workReq.specRefs = [];
    delete (workReq as any).scopeDescription;
    await classify(mockRuntime, workReq);

    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'classifier',
      expect.objectContaining({
        variables: expect.objectContaining({
          specRefs: 'none',
          scope: 'no scope description provided',
        }),
      }),
      42,
      expect.any(Object),
      undefined,
      undefined,
    );
  });

  it('extracts structured_output from full CLI JSON response (#411 regression)', async () => {
    // The CLI adapter sets structuredData to the full response: {result, cost_usd, structured_output}
    const validClassification = {
      complexity: 'standard' as const,
      reasoning: 'Multi-file change',
      estimatedUnits: 3,
      estimatedArtifacts: 5,
    };
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          result: 'some text',
          cost_usd: 0.05,
          structured_output: validClassification,
        },
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success');
    expect(result.complexity).toBe('standard');
  });

  it('falls back to parsing JSON from result text when structured_output is null', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          result: '```json\n{"complexity":"complex","reasoning":"Architectural","estimatedUnits":8,"estimatedArtifacts":15}\n```',
          cost_usd: 0.05,
          structured_output: null,
        },
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result.event).toBe('success');
    expect(result.complexity).toBe('complex');
  });

  it('passes runWriter and runId for cost tracking', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: true,
      value: {
        output: '',
        structuredData: {
          complexity: 'simple',
          reasoning: 'Trivial',
          estimatedUnits: 1,
          estimatedArtifacts: 1,
        },
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const mockWriter = {} as any;
    await classify(mockRuntime, makeWorkRequest(), mockWriter, 'run-123', '/repo');

    expect(mockRuntime.spawnSession).toHaveBeenCalledWith(
      'classifier',
      expect.objectContaining({ workspacePath: '/repo' }),
      42,
      expect.any(Object),
      mockWriter,
      'run-123',
    );
  });
});
