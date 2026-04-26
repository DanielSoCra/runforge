// src/implementation/fix.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fix } from './fix.js';
import type { ReviewFinding, SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';
import { SessionError } from '../session-runtime/session-error.js';

vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/workspace/fix-1' }),
  mergeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  deleteUnitBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
}));

vi.mock('../lib/git.js', () => ({
  git: vi.fn().mockResolvedValue({ ok: true, value: '' }),
}));

const mockFindings: ReviewFinding[] = [
  { severity: 'critical', location: 'src/auth.ts:42', description: 'Missing null check' },
  { severity: 'important', location: 'src/auth.ts:55', description: 'Unclosed resource' },
];

const successResult: SessionResult = {
  output: 'Fixed all findings',
  structuredData: null,
  cost: 0.3,
  pitfallMarkers: [],
  exitStatus: 'completed',
};

function createMockRuntime(result: SessionResult = successResult) {
  return {
    spawnSession: vi.fn().mockResolvedValue(ok(result)),
    getCostTracker: vi.fn(),
  } as any;
}

describe('fix', () => {
  beforeEach(async () => {
    const { createWorktree, mergeWorktree, deleteUnitBranch } = await import('./worktree.js');
    vi.mocked(createWorktree).mockClear().mockResolvedValue({ ok: true, value: '/tmp/workspace/fix-1' });
    vi.mocked(mergeWorktree).mockClear().mockResolvedValue({ ok: true, value: undefined });
    vi.mocked(deleteUnitBranch).mockClear().mockResolvedValue({ ok: true, value: undefined });
  });

  it('creates a worktree, spawns a worker session, and merges the fix', async () => {
    const { createWorktree, mergeWorktree } = await import('./worktree.js');
    const runtime = createMockRuntime();

    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.cost).toBe(0.3);
    }
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(mergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('embeds findings in task context and passes spec content in worker session variables', async () => {
    // Note: findings live inside vars.task (taskContext includes a ## Findings
    // section); they are NOT a separate `findings` variable, because the worker
    // prompt template does not have a {{findings}} placeholder and the contract
    // would reject it as silent-drop.
    const runtime = createMockRuntime();

    await fix(mockFindings, 'feature/42', runtime, '/tmp/repo', 'spec content here');

    const call = runtime.spawnSession.mock.calls[0];
    expect(call[0]).toBe('worker');
    const vars = call[1].variables;
    expect(vars.findings).toBeUndefined();
    expect(vars.task).toContain('Missing null check');
    expect(vars.task).toContain('Unclosed resource');
    expect(vars.specs).toContain('spec content here');
  });

  it('returns failure when worker session fails', async () => {
    const failResult: SessionResult = {
      output: 'Failed',
      structuredData: null,
      cost: 0.2,
      pitfallMarkers: [],
      exitStatus: 'failed',
    };
    const runtime = createMockRuntime(failResult);

    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
    }
  });

  it('returns error when worktree creation fails', async () => {
    const { createWorktree } = await import('./worktree.js');
    vi.mocked(createWorktree).mockResolvedValueOnce(err(new Error('disk full')));

    const runtime = createMockRuntime();
    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('disk full');
    }
    // Should not spawn a session if worktree failed
    expect(runtime.spawnSession).not.toHaveBeenCalled();
  });

  it('cleans up worktree even on failure', async () => {
    const runtime = {
      spawnSession: vi.fn().mockRejectedValue(new Error('unexpected')),
      getCostTracker: vi.fn(),
    } as any;

    const { deleteUnitBranch } = await import('./worktree.js');
    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
    }
    // Branch cleanup should happen in finally block
    expect(deleteUnitBranch).toHaveBeenCalled();
  });

  it('uses regression-test-first protocol in worker prompt', async () => {
    const runtime = createMockRuntime();
    await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    const call = runtime.spawnSession.mock.calls[0];
    const vars = call[1].variables;
    expect(vars.task).toContain('Regression-Test-First');
  });

  it('preserves cost from SessionError when spawnSession returns error Result', async () => {
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue(err(SessionError.rateLimited(1.75))),
      getCostTracker: vi.fn(),
    } as any;

    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.cost).toBe(1.75);
    }
  });

  it('preserves cost from SessionError when spawnSession throws', async () => {
    const runtime = {
      spawnSession: vi.fn().mockRejectedValue(SessionError.containmentBreached('sandbox escape', 2.5)),
      getCostTracker: vi.fn(),
    } as any;

    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.cost).toBe(2.5);
    }
  });

  it('returns failure when git checkout of target branch fails before merge', async () => {
    const { git } = await import('../lib/git.js');
    const { mergeWorktree } = await import('./worktree.js');
    // Make checkout fail (e.g., branch doesn't exist or dirty state)
    vi.mocked(git).mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout') {
        return { ok: false, error: new Error('error: pathspec \'bad-branch\' did not match any file(s)') } as any;
      }
      return { ok: true, value: '' };
    });

    const runtime = createMockRuntime();
    const result = await fix(mockFindings, 'bad-branch', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.output).toContain('Checkout failed');
    }
    // mergeWorktree must NOT be called if checkout failed
    expect(mergeWorktree).not.toHaveBeenCalled();
  });

  it('returns cost 0 when spawnSession returns non-SessionError', async () => {
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue(err(new Error('generic failure'))),
      getCostTracker: vi.fn(),
    } as any;

    const result = await fix(mockFindings, 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.cost).toBe(0);
    }
  });
});
