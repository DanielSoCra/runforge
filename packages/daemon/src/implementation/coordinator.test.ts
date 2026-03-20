import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImplementationCoordinator } from './coordinator.js';
import { git } from '../lib/git.js';
import { ok } from '../lib/result.js';
import type { WorkRequest, SessionResult } from '../types.js';

// Mock the worktree module so tests don't need real git worktrees
vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/workspace' }),
  removeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  getWorktreeDiffSize: vi.fn().mockResolvedValue({ ok: true, value: 50 }),
  mergeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
}));

// Also mock git so checkout doesn't run against a real repo for most tests
vi.mock('../lib/git.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/git.js')>();
  return {
    ...original,
    git: vi.fn().mockResolvedValue({ ok: true, value: '' }),
  };
});

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
  it('returns success:false when worker fails', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('failed');
    }
  });

  it('returns success:false when worker is blocked', async () => {
    const runtime = createMockRuntime(blockedResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('blocked');
    }
  });

  it('tracks cost in unit results', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalCost).toBe(0.3);
      expect(result.value.unitResults[0]?.cost).toBe(0.3);
    }
  });

  it('spawns worker session with correct context', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42');
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        variables: expect.objectContaining({
          task: expect.stringContaining('Add feature X'),
        }),
      }),
      42,
      undefined,
      undefined,
      undefined,
    );
  });

  it('returns success:true with batchesCompleted when single unit succeeds', async () => {
    const runtime = createMockRuntime(successResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.batchesCompleted).toBe(1);
      expect(result.value.totalCost).toBe(0.5);
    }
  });
});

// ---- Multi-unit batch tests ----

describe('ImplementationCoordinator — multi-unit', () => {
  beforeEach(async () => {
    // Reset all worktree mock call counts between tests
    const { mergeWorktree, createWorktree, removeWorktree, getWorktreeDiffSize } = await import('./worktree.js');
    vi.mocked(mergeWorktree).mockClear();
    vi.mocked(createWorktree).mockClear();
    vi.mocked(removeWorktree).mockClear();
    vi.mocked(getWorktreeDiffSize).mockClear();
  });

  it('executes two units in same batch and merges both on success', async () => {
    const { mergeWorktree } = await import('./worktree.js');

    const validUnits = [
      {
        id: 'unit-a', title: 'Unit A', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do A',
      },
      {
        id: 'unit-b', title: 'Unit B', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do B',
      },
    ];

    const runtime = {
      spawnSession: vi.fn()
        // decompose call returns the two-unit graph
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: validUnits },
          cost: 0.2,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        // worker sessions for unit-a and unit-b
        .mockResolvedValue(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.unitResults).toHaveLength(2);
      expect(result.value.batchesCompleted).toBe(1);
    }
    // Both units should be merged
    expect(mergeWorktree).toHaveBeenCalledTimes(2);
  });

  it('skips completed batches when checkpoint is provided', async () => {
    const validUnits = [
      {
        id: 'unit-a', title: 'Unit A', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do A',
      },
      {
        id: 'unit-b', title: 'Unit B', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 1,
        verificationCommand: '', context: 'do B',
      },
    ];

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: validUnits },
          cost: 0.2,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValue(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    // checkpoint: 1 means batch 0 is already done, start from batch 1
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
      checkpoint: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      // Only unit-b (batch 1) should be in results
      expect(result.value.unitResults).toHaveLength(1);
      expect(result.value.unitResults[0]?.unitId).toBe('unit-b');
    }
  });

  it('merges successful units even when some units fail in the same batch', async () => {
    const { mergeWorktree } = await import('./worktree.js');

    const validUnits = [
      {
        id: 'unit-pass', title: 'Passing', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do pass',
      },
      {
        id: 'unit-fail', title: 'Failing', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do fail',
      },
    ];

    const runtime = {
      spawnSession: vi.fn()
        // decompose
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: validUnits },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        // unit-pass succeeds, unit-fail fails
        .mockResolvedValueOnce(ok(successResult))
        .mockResolvedValueOnce(ok(failResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // One failure but not ALL failed, so we continue and merge the passing one
      expect(result.value.success).toBe(true);
      expect(result.value.unitResults).toHaveLength(2);
    }
    // Only the passing unit merges
    expect(mergeWorktree).toHaveBeenCalledTimes(1);
    expect(mergeWorktree).toHaveBeenCalledWith('unit-pass', 'feature/42', '/tmp/repo');
  });

  it('returns success:false with error when unit is blocked', async () => {
    const validUnits = [
      {
        id: 'unit-blocked', title: 'Blocked', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'blocked unit',
      },
    ];

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: validUnits },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(blockedResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('blocked');
      expect(result.value.error).toContain('unit-blocked');
    }
  });

  it('returns err when decomposition fails', async () => {
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue({ ok: false, error: new Error('API timeout') }),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'complex',
      specContent: 'spec',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Decomposition failed');
    }
  });
});
