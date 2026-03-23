// src/validation/reviewer-session.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ReviewFindingsSchema, createReviewerGate, extractDiscoveredIssues } from './reviewer-session.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import { SessionError } from '../session-runtime/session-error.js';

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
        variables: { rubric: 'my rubric', cwd: '/my/workspace', diff: expect.stringContaining('diff unavailable'), specs: 'No spec content available for this review.', knownIssues: '' },
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
          knownIssues: '',
        },
        workspacePath: '/my/workspace',
      }),
      99,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });

  it('sets diff fallback when not provided and always includes specs fallback (#272)', async () => {
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
    expect(passedVariables).toHaveProperty('diff');
    expect(passedVariables.diff).toContain('diff unavailable');
    expect(passedVariables).toHaveProperty('specs');
    expect(passedVariables.specs).toBe('No spec content available for this review.');
  });

  it('includes knownIssues variable when knowledgeContext is provided (#326)', async () => {
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

    const knowledgeCtx = '## Known Issues\n- Parser crashes on empty input';
    const gate = createReviewerGate(
      'spec-compliance', 'reviewer-spec', 'my rubric', runtime, 99,
      undefined, undefined, 'some diff', 'some spec', undefined, knowledgeCtx,
    );
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    expect(passedVariables.knownIssues).toBe('## Known Issues\n- Parser crashes on empty input');
  });

  it('sets knownIssues to empty string when knowledgeContext is not provided (#326, #340)', async () => {
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
      'quality', 'reviewer-quality', 'rubric', runtime, 42,
    );
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    expect(passedVariables.knownIssues).toBe('');
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

  it('does not retry on SessionError.rateLimited — propagates immediately (#267)', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: SessionError.rateLimited(0.5, 30000) }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.description).toContain('Rate limited');
    // Must NOT retry — only 1 call to spawnSession
    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
  });

  it('does not retry on SessionError.budgetExceeded — propagates immediately (#267)', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: SessionError.budgetExceeded('monthly cap reached') }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.description).toContain('Budget exceeded');
    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
  });

  it('does not retry on SessionError.containmentBreached — propagates immediately (#267)', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: SessionError.containmentBreached('sandbox escape', 0.2) }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('security', 'reviewer-security', 'Check security', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    expect(result.findings[0]?.description).toContain('Containment breach');
    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
  });

  it('still retries on generic Error (non-SessionError) failures', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: new Error('network timeout') })
        .mockResolvedValueOnce({ ok: false, error: new Error('network timeout again') }),
      getCostTracker: vi.fn(),
    } as unknown as SessionRuntime;

    const gate = createReviewerGate('quality', 'reviewer-quality', 'Check quality', runtime, 42);
    const result = await gate.execute('/workspace');

    expect(result.passed).toBe(false);
    // Generic errors should still retry — 2 calls
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('diff fallback replaces {{diff}} placeholder instead of leaving literal template syntax (#272)', async () => {
    // Regression: when diff is undefined, renderTemplate received no 'diff' key,
    // leaving literal {{diff}} in the reviewer prompt. Verify the fallback is set.
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

    // Pass undefined for diff (simulates git diff failure)
    const gate = createReviewerGate(
      'quality', 'reviewer-quality', 'rubric', runtime, 42,
      undefined, undefined,
      undefined, // diff = undefined
    );
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    // The key must exist so renderTemplate replaces {{diff}}
    expect(passedVariables).toHaveProperty('diff');
    expect(passedVariables.diff).not.toBe('{{diff}}');
    expect(passedVariables.diff).toContain('diff unavailable');
  });

  it('preserves empty-string diff as-is — empty diff is meaningful, not a failure (#272)', async () => {
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
      'quality', 'reviewer-quality', 'rubric', runtime, 42,
      undefined, undefined,
      '', // diff = empty string (git diff succeeded but no changes)
    );
    await gate.execute('/workspace');

    const callArgs = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedVariables = (callArgs[1] as { variables: Record<string, string> }).variables;
    // Empty string means "no changes" — distinct from undefined which means "failed to obtain"
    expect(passedVariables.diff).toBe('');
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

  it('returns discoveredIssues from structured output', async () => {
    const runtime = makeRuntime({
      ok: true,
      value: {
        structuredData: {
          findings: [],
          summary: 'Approved',
          approved: true,
          discoveredIssues: [
            { artifactPatterns: ['src/foo.ts'], description: 'Potential race condition' },
          ],
        },
        output: '',
        cost: 0.1,
        pitfallMarkers: [],
        exitStatus: 'completed',
      },
    });

    const gate = createReviewerGate('quality', 'reviewer-quality', 'rubric', runtime, 42);
    const result = await gate.execute('/workspace');
    expect((result as { discoveredIssues?: unknown[] }).discoveredIssues).toHaveLength(1);
  });
});

describe('ReviewFindingsSchema with discoveredIssues', () => {
  it('accepts input with discoveredIssues', () => {
    const input = {
      findings: [],
      summary: 'ok',
      approved: true,
      discoveredIssues: [
        { artifactPatterns: ['src/a.ts'], description: 'some issue' },
      ],
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts input without discoveredIssues (backward-compatible)', () => {
    const input = {
      findings: [],
      summary: 'ok',
      approved: true,
    };
    const result = ReviewFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe('extractDiscoveredIssues', () => {
  it('returns discoveredIssues when present', () => {
    const issues = [
      { artifactPatterns: ['src/foo.ts'], description: 'Race condition' },
    ];
    const result = extractDiscoveredIssues({
      gate: 'quality',
      passed: true,
      findings: [],
      discoveredIssues: issues,
    });
    expect(result).toEqual(issues);
  });

  it('returns empty array when discoveredIssues is absent', () => {
    const result = extractDiscoveredIssues({
      gate: 'quality',
      passed: true,
      findings: [],
    });
    expect(result).toEqual([]);
  });
});

describe('reviewer templates contain {{knownIssues}} placeholder (#340)', () => {
  const templateNames = ['reviewer-spec.md', 'reviewer-quality.md', 'reviewer-security.md'];
  const promptsDir = `${import.meta.dirname}/../../../../prompts`;

  for (const name of templateNames) {
    it(`${name} contains {{knownIssues}} placeholder`, async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const content = fs.readFileSync(path.join(promptsDir, name), 'utf-8');
      expect(content).toContain('{{knownIssues}}');
    });
  }
});
