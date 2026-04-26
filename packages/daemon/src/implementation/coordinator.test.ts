import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ImplementationCoordinator } from './coordinator.js';
import { git } from '../lib/git.js';
import { ok } from '../lib/result.js';
import { SessionError } from '../session-runtime/session-error.js';
import type { WorkRequest, SessionResult } from '../types.js';

// Mock the worktree module so tests don't need real git worktrees
vi.mock('./worktree.js', () => ({
  createWorktree: vi.fn().mockResolvedValue({ ok: true, value: '/tmp/workspace' }),
  removeWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  deleteUnitBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
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
    // Branch should still be cleaned up on all-failed early return (#133)
    const { deleteUnitBranch } = await import('./worktree.js');
    expect(deleteUnitBranch).toHaveBeenCalledWith('issue-42', '/tmp/repo');
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

  it('threads options.specContent into the simple-complexity worker (Codex follow-up)', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'simple',
      specContent: 'L1 spec body for issue 42',
    });
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        variables: expect.objectContaining({
          specs: 'L1 spec body for issue 42',
        }),
      }),
      42,
      undefined,
      undefined,
      undefined,
    );
  });

  it('uses default verification command for simple-complexity worker', async () => {
    const runtime = createMockRuntime(failResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42');
    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'worker',
      expect.objectContaining({
        variables: expect.objectContaining({
          verification: 'pnpm -r typecheck && pnpm -r test',
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

  it('injects matched gotchas as pitfalls variable in worker session (#45)', async () => {
    const unitWithArtifacts = {
      id: 'unit-gotcha', title: 'Unit with artifacts', specIds: [], specContent: '',
      expectedArtifacts: ['src/models/*.ts'], dependencies: [], batchNumber: 0,
      verificationCommand: '', context: 'implement model',
    };

    const mockGotchaStore = {
      match: vi.fn().mockResolvedValue([
        {
          id: 'gotcha-1',
          artifactPatterns: ['src/**/*.ts'],
          description: 'Always check null returns from database queries',
          sourceIssue: 10,
          confidence: 1,
          createdAt: '2026-01-01T00:00:00Z',
          hitCount: 3,
          promoted: false,
          archived: false,
          originType: 'autonomous' as const,
          priorityTier: 'normal' as const,
        },
      ]),
      store: vi.fn().mockResolvedValue(0),
    } as any;

    const runtime = {
      spawnSession: vi.fn()
        // decompose call returns unit with expectedArtifacts
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: [unitWithArtifacts] },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        // worker session
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0, mockGotchaStore);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // GotchaStore.match should have been called with unit's expectedArtifacts
    expect(mockGotchaStore.match).toHaveBeenCalledWith(['src/models/*.ts']);

    // Worker session (second spawnSession call) should receive pitfalls in variables
    const workerCall = runtime.spawnSession.mock.calls[1];
    expect(workerCall[1].variables.pitfalls).toContain('Always check null returns from database queries');
  });

  it('injects v2 KnowledgeStore records into implementation sessions (#364)', async () => {
    const unitWithArtifacts = {
      id: 'unit-knowledge', title: 'Unit with artifacts', specIds: [], specContent: '',
      expectedArtifacts: ['src/models/*.ts'], dependencies: [], batchNumber: 0,
      verificationCommand: '', context: 'implement model',
    };

    const mockKnowledgeStore = {
      matchRecords: vi.fn().mockResolvedValue([
        {
          id: 'kr-1',
          recordType: 'technical_pitfall',
          artifactPatterns: ['src/**/*.ts'],
          description: 'Database connections must be closed in finally blocks',
          sourceId: 'issue-20',
          confidence: 1,
          createdAt: '2026-01-01T00:00:00Z',
          hitCount: 4,
          lifecycleStatus: 'active',
          originType: 'autonomous',
          priorityTier: 'normal',
        },
        {
          id: 'kr-2',
          recordType: 'operator_correction',
          artifactPatterns: ['src/models/**'],
          description: 'Always use parameterized queries — never string interpolation',
          sourceId: 'issue-25',
          confidence: 1,
          createdAt: '2026-02-01T00:00:00Z',
          hitCount: 2,
          lifecycleStatus: 'active',
          originType: 'operator',
          priorityTier: 'elevated',
        },
      ]),
    } as any;

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: [unitWithArtifacts] },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    // No v1 gotchaStore — only v2 knowledgeStore
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0, undefined, mockKnowledgeStore);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // KnowledgeStore.matchRecords should be called with 'implementation' session type
    expect(mockKnowledgeStore.matchRecords).toHaveBeenCalledWith(['src/models/*.ts'], 'implementation');

    // Worker session should receive pitfalls containing v2 knowledge records
    const workerCall = runtime.spawnSession.mock.calls[1];
    expect(workerCall[1].variables.pitfalls).toContain('Database connections must be closed in finally blocks');
    expect(workerCall[1].variables.pitfalls).toContain('Always use parameterized queries');
    // Elevated record should be tagged IMPORTANT
    expect(workerCall[1].variables.pitfalls).toContain('[IMPORTANT]');
  });

  it('combines v1 gotchas and v2 knowledge records when both stores are provided (#364)', async () => {
    const unitWithArtifacts = {
      id: 'unit-combined', title: 'Unit', specIds: [], specContent: '',
      expectedArtifacts: ['src/models/*.ts'], dependencies: [], batchNumber: 0,
      verificationCommand: '', context: 'implement model',
    };

    const mockGotchaStore = {
      match: vi.fn().mockResolvedValue([
        {
          id: 'gotcha-1',
          artifactPatterns: ['src/**/*.ts'],
          description: 'V1 gotcha: check null returns',
          sourceIssue: 10,
          confidence: 1,
          createdAt: '2026-01-01T00:00:00Z',
          hitCount: 3,
          promoted: false,
          archived: false,
          originType: 'autonomous' as const,
          priorityTier: 'normal' as const,
        },
      ]),
      store: vi.fn().mockResolvedValue(0),
    } as any;

    const mockKnowledgeStore = {
      matchRecords: vi.fn().mockResolvedValue([
        {
          id: 'kr-1',
          recordType: 'operator_correction',
          artifactPatterns: ['src/models/**'],
          description: 'V2 record: use parameterized queries',
          sourceId: 'issue-25',
          confidence: 1,
          createdAt: '2026-02-01T00:00:00Z',
          hitCount: 2,
          lifecycleStatus: 'active',
          originType: 'operator',
          priorityTier: 'elevated',
        },
      ]),
    } as any;

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: [unitWithArtifacts] },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0, mockGotchaStore, mockKnowledgeStore);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // Both stores should have been queried
    expect(mockGotchaStore.match).toHaveBeenCalledWith(['src/models/*.ts']);
    expect(mockKnowledgeStore.matchRecords).toHaveBeenCalledWith(['src/models/*.ts'], 'implementation');

    // Worker session should receive combined pitfalls from both v1 and v2
    const workerCall = runtime.spawnSession.mock.calls[1];
    expect(workerCall[1].variables.pitfalls).toContain('V1 gotcha: check null returns');
    expect(workerCall[1].variables.pitfalls).toContain('V2 record: use parameterized queries');
  });

  it('continues without knowledge injection when KnowledgeStore.matchRecords rejects (#454)', async () => {
    const unitWithArtifacts = {
      id: 'unit-ks-fail', title: 'Unit with artifacts', specIds: [], specContent: '',
      expectedArtifacts: ['src/models/*.ts'], dependencies: [], batchNumber: 0,
      verificationCommand: '', context: 'implement model',
    };

    const mockKnowledgeStore = {
      matchRecords: vi.fn().mockRejectedValue(new Error('FS read error: ENOENT')),
    } as any;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: [unitWithArtifacts] },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0, undefined, mockKnowledgeStore);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // matchRecords was called and rejected
    expect(mockKnowledgeStore.matchRecords).toHaveBeenCalledWith(['src/models/*.ts'], 'implementation');

    // Coordinator logged the failure
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[coordinator] Failed to match knowledge records for unit-ks-fail'),
      expect.any(Error),
    );

    // Worker still ran and succeeded despite knowledge store failure
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2); // decompose + worker
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.unitResults).toHaveLength(1);
    }

    // Worker should have empty pitfalls (no knowledge injected)
    const workerCall = runtime.spawnSession.mock.calls[1];
    expect(workerCall[1].variables.pitfalls).toBe('');

    warnSpy.mockRestore();
  });

  it('does not include pitfalls variable when no gotchas match (#45)', async () => {
    const unitWithArtifacts = {
      id: 'unit-no-match', title: 'Unit', specIds: [], specContent: '',
      expectedArtifacts: ['src/other/*.ts'], dependencies: [], batchNumber: 0,
      verificationCommand: '', context: 'implement other',
    };

    const mockGotchaStore = {
      match: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue(0),
    } as any;

    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: [unitWithArtifacts] },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0, mockGotchaStore);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // Worker session should have empty pitfalls (batch.ts always sets pitfalls key per #144)
    const workerCall = runtime.spawnSession.mock.calls[1];
    expect(workerCall[1].variables.pitfalls).toBe('');
  });
});

// ---- Multi-unit batch tests ----

describe('ImplementationCoordinator — multi-unit', () => {
  beforeEach(async () => {
    // Reset all worktree mock call counts between tests
    const { mergeWorktree, createWorktree, removeWorktree, deleteUnitBranch, getWorktreeDiffSize } = await import('./worktree.js');
    vi.mocked(mergeWorktree).mockClear();
    vi.mocked(createWorktree).mockClear();
    vi.mocked(removeWorktree).mockClear();
    vi.mocked(deleteUnitBranch).mockClear();
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
    // Branch should still be cleaned up on early return (#133)
    const { deleteUnitBranch } = await import('./worktree.js');
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-blocked', '/tmp/repo');
  });

  it('collects handoff notes from timed-out units in failure result (#11)', async () => {
    const timedOutResult: SessionResult = {
      output: 'partial work [HANDOFF]Stopped at: step 3 of 5\nNext: continue from step 3[/HANDOFF]',
      structuredData: null,
      cost: 0.4,
      pitfallMarkers: [],
      exitStatus: 'timed-out',
      handoffNote: 'Stopped at: step 3 of 5\nNext: continue from step 3',
    };

    const runtime = createMockRuntime(timedOutResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.handoffNotes).toBeDefined();
      const notes = result.value.handoffNotes!;
      expect(notes.size).toBe(1);
      const note = [...notes.values()][0];
      expect(note).toContain('Stopped at: step 3 of 5');
    }
  });

  it('prepends handoff note to worker context on retry (#11)', async () => {
    const handoffNotes = new Map<string, string>();
    // The unit ID for a single-unit graph is `issue-<issueNumber>`
    handoffNotes.set('issue-42', 'Previous: implemented validation\nNext: write tests');

    const runtime = createMockRuntime(successResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      handoffNotes,
    });

    // Worker session should receive task context with handoff prepended
    const workerCall = runtime.spawnSession.mock.calls[0];
    const taskVar = workerCall[1].variables.task as string;
    expect(taskVar).toMatch(/^\[PREVIOUS ATTEMPT\]/);
    expect(taskVar).toContain('Previous: implemented validation');
    expect(taskVar).toContain('Add feature X'); // original context still present
  });

  it('does not prepend handoff when no notes match unit (#11)', async () => {
    const handoffNotes = new Map<string, string>();
    handoffNotes.set('other-unit', 'irrelevant handoff');

    const runtime = createMockRuntime(successResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      handoffNotes,
    });

    const workerCall = runtime.spawnSession.mock.calls[0];
    const taskVar = workerCall[1].variables.task as string;
    expect(taskVar).not.toContain('[PREVIOUS ATTEMPT]');
  });

  it('deletes unit branches after merge and for failed units (#133)', async () => {
    const { deleteUnitBranch } = await import('./worktree.js');
    vi.mocked(deleteUnitBranch).mockClear();

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
        .mockResolvedValueOnce(ok({
          output: 'decomposed',
          structuredData: { units: validUnits },
          cost: 0.1,
          pitfallMarkers: [],
          exitStatus: 'completed',
        } as SessionResult))
        .mockResolvedValueOnce(ok(successResult))
        .mockResolvedValueOnce(ok(failResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    // Both branches should be deleted — successful after merge, failed after batch
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-pass', '/tmp/repo');
    expect(deleteUnitBranch).toHaveBeenCalledWith('unit-fail', '/tmp/repo');
    expect(deleteUnitBranch).toHaveBeenCalledTimes(2);
  });

  it('deletes unit branch after successful single-unit implementation (#133)', async () => {
    const { deleteUnitBranch } = await import('./worktree.js');
    vi.mocked(deleteUnitBranch).mockClear();

    const runtime = createMockRuntime(successResult);
    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    await coord.implement(mockWorkRequest, 'feature/42');

    // The single unit's branch should be cleaned up after merge
    expect(deleteUnitBranch).toHaveBeenCalledTimes(1);
  });

  it('merges successful units when needs-context is in the same batch — not grouped with blocked (#235)', async () => {
    const { mergeWorktree } = await import('./worktree.js');
    vi.mocked(mergeWorktree).mockClear();

    const needsContextResult: SessionResult = {
      output: 'I need more spec context',
      structuredData: null,
      cost: 0.2,
      pitfallMarkers: [],
      exitStatus: 'needs-context',
    };

    const validUnits = [
      {
        id: 'unit-ok', title: 'Succeeds', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do ok',
      },
      {
        id: 'unit-ctx', title: 'Needs context', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'needs more info',
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
        .mockResolvedValueOnce(ok(successResult))
        .mockResolvedValueOnce(ok(needsContextResult)),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The successful unit should be merged — needs-context must NOT trigger the blocked early return
      expect(result.value.success).toBe(true);
      expect(result.value.unitResults).toHaveLength(2);
    }
    // Only the successful unit merges; needs-context unit does not
    expect(mergeWorktree).toHaveBeenCalledTimes(1);
    expect(mergeWorktree).toHaveBeenCalledWith('unit-ok', 'feature/42', '/tmp/repo');
  });

  it('returns success:false when all units need context — treated as batch failure not blocked (#235)', async () => {
    const needsContextResult: SessionResult = {
      output: 'I need more spec context',
      structuredData: null,
      cost: 0.2,
      pitfallMarkers: [],
      exitStatus: 'needs-context',
    };

    const validUnits = [
      {
        id: 'unit-ctx-only', title: 'Needs context', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'needs info',
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
        .mockResolvedValueOnce(ok(needsContextResult)),
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
      // Error should say "failed" (batch failure path), NOT "blocked" (escalation path)
      expect(result.value.error).toContain('failed');
      expect(result.value.error).not.toContain('blocked');
      // Caller can inspect unitResults to see needs-context and decide to retry
      expect(result.value.unitResults[0]?.exitStatus).toBe('needs-context');
    }
  });

  it('returns success:false when git checkout fails before merge (#259)', async () => {
    const { mergeWorktree } = await import('./worktree.js');
    vi.mocked(mergeWorktree).mockClear();
    const mockedGit = vi.mocked(git);

    const validUnits = [
      {
        id: 'unit-ok', title: 'Passing', specIds: [], specContent: '',
        expectedArtifacts: [], dependencies: [], batchNumber: 0,
        verificationCommand: '', context: 'do ok',
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
        .mockResolvedValueOnce(ok(successResult)),
      getCostTracker: vi.fn(),
    } as any;

    // Make git checkout fail only for the checkout call (not other git calls during batch)
    mockedGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout') {
        return { ok: false, error: new Error('error: pathspec \'feature/42\' did not match any file(s) known to git') } as any;
      }
      return { ok: true, value: '' };
    });

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.error).toContain('Checkout failed');
    }
    // mergeUnitsSequentially should NOT have been called
    expect(mergeWorktree).not.toHaveBeenCalled();

    // Restore default git mock behavior
    mockedGit.mockResolvedValue({ ok: true, value: '' });
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

  it('propagates SessionError from decomposition instead of wrapping in generic Error (#268)', async () => {
    const sessionError = SessionError.rateLimited(0.5, 30000);
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue({ ok: false, error: sessionError }),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'complex',
      specContent: 'spec',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must be the original SessionError, not a generic Error wrapper
      expect(result.error).toBeInstanceOf(SessionError);
      expect(result.error).toBe(sessionError);
      expect((result.error as SessionError).rateLimited).toBe(true);
      expect((result.error as SessionError).cost).toBe(0.5);
    }
  });

  it('propagates SessionError with containmentBreach from decomposition (#268)', async () => {
    const sessionError = SessionError.containmentBreached('sandbox escape', 1.2);
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue({ ok: false, error: sessionError }),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'standard',
      specContent: 'spec',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SessionError);
      expect((result.error as SessionError).containmentBreach).toBe(true);
      expect((result.error as SessionError).cost).toBe(1.2);
    }
  });

  it('still wraps non-SessionError decomposition failures in generic Error (#268)', async () => {
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue({ ok: false, error: new Error('Network error') }),
      getCostTracker: vi.fn(),
    } as any;

    const coord = new ImplementationCoordinator(runtime, '/tmp/repo', 300, 0);
    const result = await coord.implement(mockWorkRequest, 'feature/42', undefined, undefined, {
      complexity: 'complex',
      specContent: 'spec',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(SessionError);
      expect(result.error.message).toContain('Decomposition failed');
    }
  });
});
