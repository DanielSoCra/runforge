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

  it('passes area and recentCommits as session variables', async () => {
    const runtime = makeRuntime({ findings: [] });
    await runProactiveReview(runtime, {
      area: 'src/validation',
      cwd: '/workspace',
      recentCommits: 'abc fix\ndef refactor',
      issueNumber: 42,
    });

    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'codebase-reviewer',
      expect.objectContaining({
        variables: expect.objectContaining({
          area: 'src/validation',
          recentCommits: 'abc fix\ndef refactor',
        }),
        workspacePath: '/workspace',
      }),
      42,
      expect.objectContaining({ jsonSchema: expect.any(String) }),
      undefined,
      undefined,
    );
  });
});
