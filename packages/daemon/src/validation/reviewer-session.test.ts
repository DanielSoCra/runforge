// src/validation/reviewer-session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ReviewFindingsSchema, createReviewerGate } from './reviewer-session.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';

describe('ReviewFindingsSchema', () => {
  it('validates correct input', () => {
    const input = {
      findings: [
        { severity: 'critical', location: 'src/foo.ts', description: 'Missing null check' },
        { severity: 'minor', location: 'src/bar.ts', description: 'Unused variable' },
      ],
      summary: 'Two issues found',
      approved: false,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates approved with no findings', () => {
    const input = {
      findings: [],
      summary: 'Looks good',
      approved: true,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects missing summary', () => {
    const input = {
      findings: [],
      approved: true,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects missing approved', () => {
    const input = {
      findings: [],
      summary: 'ok',
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects invalid severity', () => {
    const input = {
      findings: [{ severity: 'blocker', location: 'x', description: 'y' }],
      summary: 'bad',
      approved: false,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects missing findings array', () => {
    const input = {
      summary: 'ok',
      approved: true,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

function makeRuntime(spawnResult: unknown): SessionRuntime {
  return {
    spawnSession: vi.fn().mockResolvedValue(spawnResult),
    getCostTracker: vi.fn(),
  } as unknown as SessionRuntime;
}

describe('createReviewerGate', () => {
  it('returns passed=true when approved and no critical findings', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: {
          findings: [{ severity: 'minor', location: 'src/x.ts', description: 'minor issue' }],
          summary: 'Approved with minor issue',
          approved: true,
        },
        output: '',
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check code quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    expect(result.gate).toBe('quality');
    expect(result.findings).toHaveLength(1);
  });

  it('returns passed=false when not approved', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: {
          findings: [{ severity: 'important', location: 'src/y.ts', description: 'logic error' }],
          summary: 'Not approved',
          approved: false,
        },
        output: '',
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('spec-compliance', 'reviewer-spec', 'Check spec compliance', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.gate).toBe('spec-compliance');
  });

  it('returns passed=false when critical finding even if approved', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: {
          findings: [{ severity: 'critical', location: 'src/z.ts', description: 'security hole' }],
          summary: 'Has critical',
          approved: true,
        },
        output: '',
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('security', 'reviewer-security', 'Check security', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
  });

  it('returns passed=false when session fails', async () => {
    const runtime = makeRuntime({ ok: false, error: new Error('session timed out') });

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.severity).toBe('critical');
    expect(result.findings[0]?.description).toBe('session timed out');
  });

  it('returns passed=false when structured output is invalid', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: { bad: 'data' },
        output: '',
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.location).toBe('output');
  });

  it('passes cwd and rubric to session runtime', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: { findings: [], summary: 'ok', approved: true },
        output: '',
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('spec-compliance', 'reviewer-spec', 'my rubric', runtime, 99);
    await gate.execute('/my/workspace');

    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'reviewer-spec',
      expect.objectContaining({
        variables: { rubric: 'my rubric', cwd: '/my/workspace', specs: 'No spec content available for this review.' },
        workspacePath: '/my/workspace',
      }),
      99,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });

  it('passes diff and specs variables when provided', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: { findings: [], summary: 'ok', approved: true },
        output: '',
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate(
      'spec-compliance', 'reviewer-spec', 'my rubric', runtime, 99,
      undefined, undefined,
      '--- a/file.ts\n+++ b/file.ts\n@@ added line',
      '# Spec Content\nAcceptance criteria here',
    );
    await gate.execute('/my/workspace');

    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'reviewer-spec',
      expect.objectContaining({
        variables: {
          rubric: 'my rubric',
          cwd: '/my/workspace',
          diff: '--- a/file.ts\n+++ b/file.ts\n@@ added line',
          specs: '# Spec Content\nAcceptance criteria here',
        },
        workspacePath: '/my/workspace',
      }),
      99,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });

  it('omits diff from variables when not provided but always includes specs fallback', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: { findings: [], summary: 'ok', approved: true },
        output: '',
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('quality', 'reviewer-quality', 'rubric', runtime, 42);
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    expect(passedVariables).not.toHaveProperty('diff');
    expect(passedVariables).toHaveProperty('specs');
    expect(passedVariables.specs).toBe('No spec content available for this review.');
  });

  it('retries once on session failure then returns failure', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: new Error('session timed out') })
        .mockResolvedValueOnce({ ok: false, error: new Error('session timed out again') }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('retries once on session failure then succeeds', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: new Error('session timed out') })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            structuredData: { findings: [], summary: 'ok', approved: true },
            output: '', cost: 0.05, pitfallMarkers: [], exitStatus: 'completed',
          },
        }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('retries once on invalid structured output then returns failure', async () => {
    const badOutput = {
      ok: true,
      value: {
        structuredData: { bad: 'data' },
        output: '', cost: 0.1, pitfallMarkers: [], exitStatus: 'completed',
      },
    };
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(badOutput)
        .mockResolvedValueOnce(badOutput),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('retries once on invalid structured output then succeeds', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          value: {
            structuredData: { bad: 'data' },
            output: '', cost: 0.1, pitfallMarkers: [], exitStatus: 'completed',
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: {
            structuredData: { findings: [], summary: 'ok', approved: true },
            output: '', cost: 0.05, pitfallMarkers: [], exitStatus: 'completed',
          },
        }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(true);
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('uses fallback specs text when specs is empty string (#169)', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: { findings: [], summary: 'ok', approved: true },
        output: '',
        cost: 0.05,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate(
      'spec-compliance', 'reviewer-spec', 'rubric', runtime, 42,
      undefined, undefined,
      'some diff', '',
    );
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    expect(passedVariables.specs).toBe('No spec content available for this review.');
  });
});
