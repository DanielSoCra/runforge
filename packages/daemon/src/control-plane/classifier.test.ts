import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classify } from './classifier.js';

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
    expect(result).toBe('success:simple');
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
    expect(result).toBe('success');
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
    expect(result).toBe('success');
  });

  it('falls back to success:simple when session fails', async () => {
    mockRuntime.spawnSession.mockResolvedValue({
      ok: false,
      error: new Error('Budget exceeded'),
    });

    const result = await classify(mockRuntime, makeWorkRequest());
    expect(result).toBe('success:simple');
  });

  it('falls back to success:simple when output is invalid', async () => {
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
    expect(result).toBe('success:simple');
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
