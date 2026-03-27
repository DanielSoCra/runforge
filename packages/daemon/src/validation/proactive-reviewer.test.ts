// src/validation/proactive-reviewer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runProactiveReview } from './proactive-reviewer.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SessionResult } from '../types.js';

function makeRuntime(structuredData: unknown, ok = true): SessionRuntime {
  const result = ok
    ? { ok: true as const, value: { output: '', structuredData, cost: 0.1, pitfallMarkers: [], exitStatus: 'completed' as const } }
    : { ok: false as const, error: new Error('session failed') };
  return {
    spawnSession: vi.fn().mockResolvedValue(result),
  } as unknown as SessionRuntime;
}

describe('runProactiveReview', () => {
  it('returns findings from a successful session', async () => {
    const structuredData = {
      findings: [
        { title: 'Dead code in utils', severity: 'minor', location: 'src/utils.ts:42', description: 'Unused function', evidence: 'grep shows no callers' },
      ],
    };
    const runtime = makeRuntime(structuredData);

    const result = await runProactiveReview(runtime, {
      area: 'src/utils',
      cwd: '/workspace',
      recentCommits: 'abc123 fix utils',
      issueNumber: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.title).toBe('Dead code in utils');
    }
  });

  it('returns empty findings when session produces no findings', async () => {
    const runtime = makeRuntime({ findings: [] });
    const result = await runProactiveReview(runtime, {
      area: 'src/lib',
      cwd: '/workspace',
      recentCommits: '',
      issueNumber: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings).toHaveLength(0);
    }
  });

  it('returns error when session fails', async () => {
    const runtime = makeRuntime(null, false);
    const result = await runProactiveReview(runtime, {
      area: 'src/lib',
      cwd: '/workspace',
      recentCommits: '',
      issueNumber: 0,
    });

    expect(result.ok).toBe(false);
  });

  it('returns error when session produces invalid structured output', async () => {
    const runtime = makeRuntime({ notFindings: true });
    const result = await runProactiveReview(runtime, {
      area: 'src/lib',
      cwd: '/workspace',
      recentCommits: '',
      issueNumber: 0,
    });

    expect(result.ok).toBe(false);
  });

  it('passes rubric containing all scanning areas to spawnSession', async () => {
    const runtime = makeRuntime({ findings: [] });
    await runProactiveReview(runtime, {
      area: 'src/lib',
      cwd: '/workspace',
      recentCommits: '',
      issueNumber: 0,
    });

    const call = vi.mocked(runtime.spawnSession).mock.calls[0]!;
    const variables = (call[1] as { variables: Record<string, string> }).variables;
    expect(variables.rubric).toContain('Spec-code drift');
    expect(variables.rubric).toContain('Dead code');
    expect(variables.rubric).toContain('Security regression');
    expect(variables.rubric).toContain('Convention violations');
    expect(variables.rubric).toContain('Test coverage gaps');
    // area no longer passed directly — mapped to category (#339)
    expect(variables.category).toBe('src/lib');
  });

  it('passes template-required variables (category, maxIssues) and proactive context', async () => {
    const runtime = makeRuntime({ findings: [] });
    await runProactiveReview(runtime, {
      area: 'src/validation',
      cwd: '/workspace',
      recentCommits: 'abc fix\ndef refactor',
      issueNumber: 42,
    });

    const call = vi.mocked(runtime.spawnSession).mock.calls[0]!;
    const variables = (call[1] as { variables: Record<string, string> }).variables;

    // Template-required variables (fixes #339 — these must match codebase-reviewer.md placeholders)
    expect(variables.category).toBe('src/validation');
    expect(variables.maxIssues).toBe('10');

    // Proactive context variables
    expect(variables.rubric).toContain('Exploratory codebase review');
    expect(variables.recentCommits).toBe('abc fix\ndef refactor');

    // Verify full call signature
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'codebase-reviewer',
      expect.objectContaining({ workspacePath: '/workspace' }),
      42,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });

  it('rejects findings that omit title — regression for #430 (prompt example was missing title field)', async () => {
    // The codebase-reviewer prompt example previously showed findings without a `title` field.
    // When the model followed that example, ProactiveResultSchema.safeParse would fail and all
    // findings would be silently discarded. This test verifies that title is required.
    const structuredData = {
      findings: [
        { severity: 'important', location: 'src/foo.ts:10', description: 'Missing check', evidence: 'Line 10 shows...' },
      ],
    };
    const runtime = makeRuntime(structuredData);
    const result = await runProactiveReview(runtime, {
      area: 'src/foo',
      cwd: '/workspace',
      recentCommits: '',
      issueNumber: 430,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid structured output');
    }
  });

  it('forwards runWriter and runId to spawnSession when provided', async () => {
    const runtime = makeRuntime({ findings: [] });
    const fakeRunWriter = { write: vi.fn() } as unknown as import('../supabase/run-writer.js').SupabaseRunWriter;
    const fakeRunId = 'run-abc-123';

    const result = await runProactiveReview(runtime, {
      area: 'src/validation',
      cwd: '/workspace',
      recentCommits: 'abc fix',
      issueNumber: 7,
      runWriter: fakeRunWriter,
      runId: fakeRunId,
    });

    expect(result.ok).toBe(true);
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'codebase-reviewer',
      expect.objectContaining({ workspacePath: '/workspace' }),
      7,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      fakeRunWriter,
      fakeRunId,
    );
  });
});
