import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImplementationCoordinator } from './coordinator.js';
import { git } from '../lib/git.js';
import { ok } from '../lib/result.js';
import type { WorkRequest, SessionResult } from '../types.js';

const mockWorkRequest: WorkRequest = {
  issueNumber: 42,
  title: 'Add feature X',
  body: 'Implement feature X per FUNC-AC-PIPELINE',
  labels: ['ready'],
  specRefs: ['FUNC-AC-PIPELINE'],
};

function createMockRuntime(sessionResult: SessionResult) {
  return {
    spawnSession: vi.fn().mockResolvedValue(ok(sessionResult)),
    getCostTracker: vi.fn(),
  } as any;
}

const successResult: SessionResult = {
  output: 'Implementation complete',
  structuredData: null,
  cost: 0.5,
  pitfallMarkers: [],
  exitStatus: 'completed',
};

const failResult: SessionResult = {
  output: 'Something went wrong',
  structuredData: null,
  cost: 0.3,
  pitfallMarkers: [],
  exitStatus: 'failed',
};

const blockedResult: SessionResult = {
  output: 'I need clarification',
  structuredData: null,
  cost: 0.1,
  pitfallMarkers: [],
  exitStatus: 'blocked',
};

describe('ImplementationCoordinator', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'coordinator-'));
    await git(['init'], repoDir);
    await git(['checkout', '-b', 'main'], repoDir);
    await writeFile(join(repoDir, 'README.md'), '# Test');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'initial'], repoDir);
    // Create feature branch
    await git(['checkout', '-b', 'feature/42'], repoDir);
    await git(['checkout', 'main'], repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns success:false when worker fails', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, repoDir);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('failed');
    }
  });

  it('returns success:false when worker is blocked', async () => {
    const runtime = createMockRuntime(blockedResult);
    const coord = new ImplementationCoordinator(runtime, repoDir);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('blocked');
    }
  });

  it('tracks cost in unit results', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, repoDir);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalCost).toBe(0.3);
      expect(result.value.unitResults[0]?.cost).toBe(0.3);
    }
  });

  it('spawns worker session with correct context', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, repoDir);
    await coord.implement(mockWorkRequest, 'feature/42');
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        variables: expect.objectContaining({
          task: expect.stringContaining('Add feature X'),
        }),
      }),
      42,
    );
  });

  it('cleans up worktree even on failure', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, repoDir);
    await coord.implement(mockWorkRequest, 'feature/42');
    // Verify worktree was cleaned up (only main worktree should remain)
    const listResult = await git(['worktree', 'list'], repoDir);
    if (listResult.ok) {
      const lines = listResult.value.split('\n').filter(Boolean);
      expect(lines.length).toBe(1); // only the main worktree
    }
  });
});
