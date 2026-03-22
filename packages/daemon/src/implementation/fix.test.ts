// src/implementation/fix.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fix } from './fix.js';
import type { ReviewFinding, SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';

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

    const result = await fix(mockFindings, ['STACK-AC-IMPL'], 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.cost).toBe(0.3);
    }
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(mergeWorktree).toHaveBeenCalledTimes(1);
  });

  it('passes findings and spec content in worker session variables', async () => {
    const runtime = createMockRuntime();

    await fix(mockFindings, ['STACK-AC-IMPL'], 'feature/42', runtime, '/tmp/repo', 'spec content here');

    const call = runtime.spawnSession.mock.calls[0];
    expect(call[0]).toBe('worker');
    const vars = call[1].variables;
    expect(vars.findings).toContain('Missing null check');
    expect(vars.findings).toContain('Unclosed resource');
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

    const result = await fix(mockFindings, ['SPEC-1'], 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
    }
  });

  it('returns error when worktree creation fails', async () => {
    const { createWorktree } = await import('./worktree.js');
    vi.mocked(createWorktree).mockResolvedValueOnce(err(new Error('disk full')));

    const runtime = createMockRuntime();
    const result = await fix(mockFindings, ['SPEC-1'], 'feature/42', runtime, '/tmp/repo');

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
    const result = await fix(mockFindings, ['SPEC-1'], 'feature/42', runtime, '/tmp/repo');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
    }
    // Branch cleanup should happen in finally block
    expect(deleteUnitBranch).toHaveBeenCalled();
  });

  it('uses regression-test-first protocol in worker prompt', async () => {
    const runtime = createMockRuntime();
    await fix(mockFindings, ['SPEC-1'], 'feature/42', runtime, '/tmp/repo');

    const call = runtime.spawnSession.mock.calls[0];
    const vars = call[1].variables;
    expect(vars.task).toContain('Regression-Test-First');
  });
});
