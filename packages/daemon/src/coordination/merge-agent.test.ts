// src/coordination/merge-agent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '../lib/result.js';
import { createMergeAgent } from './merge-agent.js';
import type { MergeAgentDeps, MergeAgentConfig } from './merge-agent.js';
import type { MergeQueueEntry } from './types.js';

function makeEntry(overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: 'entry-1',
    prNumber: 101,
    claimId: 'claim-1',
    issueNumber: 42,
    headRef: 'feat/test',
    batchId: null,
    dependencies: [],
    priority: 0,
    mergePhase: 'queued',
    status: 'queued',
    mergeCommit: null,
    attempts: 0,
    lastFailureReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MergeAgentDeps> = {}): MergeAgentDeps {
  return {
    queue: {
      enqueue: vi.fn(),
      selectNext: vi.fn().mockResolvedValue(null),
      getEntry: vi.fn().mockResolvedValue(null),
      updatePhase: vi.fn().mockResolvedValue(ok(undefined)),
      updateStatus: vi.fn().mockResolvedValue(ok(undefined)),
      setMergeCommit: vi.fn().mockResolvedValue(ok(undefined)),
      incrementAttempts: vi.fn().mockResolvedValue(ok(undefined)),
      hasActiveMerge: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      checkDependencyTimeouts: vi.fn().mockResolvedValue([]),
    } as any,
    git: vi.fn().mockResolvedValue(ok('')),
    resolveConflicts: vi.fn().mockResolvedValue({ resolved: true, needsHuman: false }),
    validate: vi.fn().mockResolvedValue(ok(undefined)),
    resolveSession: vi.fn().mockResolvedValue(ok(undefined)),
    integrationBranch: 'dev',
    mergeWorktreePath: '/tmp/merge-worktree',
    ...overrides,
  };
}

const defaultConfig: MergeAgentConfig = {
  pollIntervalMs: 100,
  maxPollIntervalMs: 1600,
  validationTimeoutMs: 5000,
  conflictFileThreshold: 3,
  conflictLineThreshold: 100,
  dependencyTimeoutMs: 60000,
};

describe('merge-agent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('processEntry', () => {
    it('happy path: rebase → merge → validate → merged', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      // git rebase succeeds
      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration branch
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')); // rev-parse HEAD (merge commit)

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(true);
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'rebasing');
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'merging');
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'validating');
      expect(queue.setMergeCommit).toHaveBeenCalledWith('entry-1', 'abc123');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'merged');
    });

    it('rebase failure → status failed', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(err(new Error('rebase conflict'))) // rebase fails
        .mockResolvedValueOnce(ok('')); // rebase --abort

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'rebase conflict');
    });

    it('merge conflict → small → resolved → validate → merged', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(err(new Error('merge conflict'))) // merge --no-ff fails
        .mockResolvedValueOnce(ok('')) // commit after resolution
        .mockResolvedValueOnce(ok('def456')); // rev-parse HEAD

      // resolveConflicts returns resolved
      (deps.resolveConflicts as ReturnType<typeof vi.fn>).mockResolvedValue({
        resolved: true,
        needsHuman: false,
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(true);
      expect(deps.resolveConflicts).toHaveBeenCalled();
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'merged');
    });

    it('merge conflict → large → needs_human', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(err(new Error('merge conflict'))) // merge --no-ff fails
        .mockResolvedValueOnce(ok('')); // merge --abort

      (deps.resolveConflicts as ReturnType<typeof vi.fn>).mockResolvedValue({
        resolved: false,
        needsHuman: true,
        reason: 'Conflict too large',
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'needs_human', 'Conflict too large');
    });

    it('validation failure → revert → status failed', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')) // rev-parse HEAD
        .mockResolvedValueOnce(ok('')); // git revert

      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new Error('tests failed')),
      );

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'reverted');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'tests failed');
      // Verify revert was called
      expect(gitMock).toHaveBeenCalledWith(
        ['revert', '--no-edit', 'abc123'],
        '/tmp/merge-worktree',
      );
    });

    it('rebase failure → calls git rebase --abort before marking failed (#378)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(err(new Error('rebase conflict'))) // rebase fails
        .mockResolvedValueOnce(ok('')); // rebase --abort

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(gitMock).toHaveBeenCalledWith(['rebase', '--abort'], '/tmp/merge-worktree');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'rebase conflict');
    });

    it('merge conflict needsHuman → calls git merge --abort (#378)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(err(new Error('merge conflict'))) // merge --no-ff fails
        .mockResolvedValueOnce(ok('')); // merge --abort

      (deps.resolveConflicts as ReturnType<typeof vi.fn>).mockResolvedValue({
        resolved: false,
        needsHuman: true,
        reason: 'Conflict too large',
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(gitMock).toHaveBeenCalledWith(['merge', '--abort'], '/tmp/merge-worktree');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'needs_human', 'Conflict too large');
    });

    it('merge conflict resolution failed → calls git merge --abort (#378)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(err(new Error('merge conflict'))) // merge --no-ff fails
        .mockResolvedValueOnce(ok('')); // merge --abort

      (deps.resolveConflicts as ReturnType<typeof vi.fn>).mockResolvedValue({
        resolved: false,
        needsHuman: false,
        reason: 'LLM resolution failed',
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(gitMock).toHaveBeenCalledWith(['merge', '--abort'], '/tmp/merge-worktree');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'LLM resolution failed');
    });

    it('checkout integration branch failure → status failed (#252)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(err(new Error('checkout failed: branch not found'))); // checkout integration fails

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'checkout failed: branch not found');
    });

    it('commit after conflict resolution failure → status failed (#252)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(err(new Error('merge conflict'))) // merge --no-ff fails
        .mockResolvedValueOnce(err(new Error('nothing to commit'))); // commit after resolution fails

      (deps.resolveConflicts as ReturnType<typeof vi.fn>).mockResolvedValue({
        resolved: true,
        needsHuman: false,
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'nothing to commit');
    });

    it('rev-parse HEAD failure → status failed (#252)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout headRef
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(ok('')) // merge --no-ff succeeds
        .mockResolvedValueOnce(err(new Error('rev-parse failed'))); // rev-parse HEAD fails

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'rev-parse failed');
      // Should NOT have set merge commit with empty string
      expect(queue.setMergeCommit).not.toHaveBeenCalled();
    });

    it('revert failure after validation failure → needs_human (#252)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')) // rev-parse HEAD
        .mockResolvedValueOnce(err(new Error('revert failed: conflict'))); // revert fails

      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(
        err(new Error('tests failed')),
      );

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      expect(queue.updateStatus).toHaveBeenCalledWith(
        'entry-1',
        'needs_human',
        'validation failed and revert failed: revert failed: conflict',
      );
    });

    it('updateStatus("merged") failure on success path → returns err (#258)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);
      // All queue calls succeed except the final updateStatus('merged')
      queue.updateStatus.mockResolvedValue(err(new Error('disk full')));

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration branch
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')); // rev-parse HEAD

      // validate succeeds
      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(ok(undefined));

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('disk full');
      }
    });

    it('incrementAttempts failure → returns err before any git ops (#258)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);
      queue.incrementAttempts.mockResolvedValue(err(new Error('queue write failed')));

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('queue write failed');
      }
      // No git operations should have been called
      expect(deps.git).not.toHaveBeenCalled();
    });

    it('updatePhase("merging") failure → returns err before merge (#258)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);
      // incrementAttempts and rebasing phase succeed, merging phase fails
      queue.updatePhase
        .mockResolvedValueOnce(ok(undefined)) // rebasing
        .mockResolvedValueOnce(err(new Error('phase write failed'))); // merging

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')); // rebase

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('phase write failed');
      }
      // Should not have attempted checkout of integration branch
      expect(gitMock).toHaveBeenCalledTimes(2);
    });

    it('setMergeCommit failure → returns err before validation (#258)', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);
      queue.setMergeCommit.mockResolvedValue(err(new Error('commit write failed')));

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')); // rev-parse HEAD

      const agent = createMergeAgent(deps, defaultConfig);
      const result = await agent.processEntry('entry-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('commit write failed');
      }
      // Validation should NOT have run
      expect(deps.validate).not.toHaveBeenCalled();
    });

    it('validation timeout → status failed', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock
        .mockResolvedValueOnce(ok('')) // checkout
        .mockResolvedValueOnce(ok('')) // rebase
        .mockResolvedValueOnce(ok('')) // checkout integration
        .mockResolvedValueOnce(ok('')) // merge --no-ff
        .mockResolvedValueOnce(ok('abc123')) // rev-parse HEAD
        .mockResolvedValueOnce(ok('')); // git revert

      // validate never resolves within timeout
      (deps.validate as ReturnType<typeof vi.fn>).mockImplementation(
        (_issueNumber: number, signal: AbortSignal) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(ok(undefined)), 999999);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve(err(new Error('validation timed out')));
            });
          }),
      );

      const configWithShortTimeout = { ...defaultConfig, validationTimeoutMs: 500 };
      const agent = createMergeAgent(deps, configWithShortTimeout);

      // Start processing and advance timers
      const resultPromise = agent.processEntry('entry-1');
      await vi.advanceTimersByTimeAsync(600);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'reverted');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'validation timed out');
    });
  });

  describe('recoverStuckEntries', () => {
    it('merging phase with merge commit → advance to validating', async () => {
      const entry = makeEntry({ mergePhase: 'merging', mergeCommit: 'abc123' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);
      queue.getEntry.mockResolvedValue(entry);

      // validate succeeds
      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(ok(undefined));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'validating');
    });

    it('merging phase without merge commit → reset to queued', async () => {
      const entry = makeEntry({ mergePhase: 'merging', mergeCommit: null });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock.mockResolvedValue(ok(''));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // Worktree cleanup before reset (#378)
      expect(gitMock).toHaveBeenCalledWith(['rebase', '--abort'], '/tmp/merge-worktree');
      expect(gitMock).toHaveBeenCalledWith(['merge', '--abort'], '/tmp/merge-worktree');
      expect(gitMock).toHaveBeenCalledWith(['checkout', 'dev'], '/tmp/merge-worktree');
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'queued');
    });

    it('rebasing phase without commit → cleans worktree before reset (#378)', async () => {
      const entry = makeEntry({ mergePhase: 'rebasing', mergeCommit: null });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock.mockResolvedValue(ok(''));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // Should attempt cleanup before resetting to queued
      expect(gitMock).toHaveBeenCalledWith(['rebase', '--abort'], '/tmp/merge-worktree');
      expect(gitMock).toHaveBeenCalledWith(['merge', '--abort'], '/tmp/merge-worktree');
      expect(gitMock).toHaveBeenCalledWith(['checkout', 'dev'], '/tmp/merge-worktree');
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'queued');
    });

    it('rebasing phase → reset to queued', async () => {
      const entry = makeEntry({ mergePhase: 'rebasing' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'queued');
    });

    it('updatePhase failure during recovery → skips entry (#258)', async () => {
      const entry1 = makeEntry({ id: 'entry-1', mergePhase: 'merging', mergeCommit: 'abc123' });
      const entry2 = makeEntry({ id: 'entry-2', mergePhase: 'reverted' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry1, entry2]);

      // updatePhase fails for entry-1 (validating), succeeds otherwise
      queue.updatePhase.mockResolvedValueOnce(err(new Error('write failed')));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // entry-1 should have been skipped (no validation run)
      expect(deps.validate).not.toHaveBeenCalled();
      // entry-2 should still be processed
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-2', 'failed', 'recovered after crash in reverted phase');
    });

    it('reverted phase → mark failed', async () => {
      const entry = makeEntry({ mergePhase: 'reverted' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'recovered after crash in reverted phase');
    });
  });

  describe('recoverStuckEntries phase cleanup on validation failure (#464)', () => {
    it('validating phase + validation failure → updates mergePhase to reverted before marking failed', async () => {
      const entry = makeEntry({ mergePhase: 'validating', mergeCommit: 'abc123' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(err(new Error('tests failed')));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // Must update phase to 'reverted' BEFORE status to 'failed'
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'reverted');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'tests failed');

      // Phase update must come before status update
      const phaseCallOrder = queue.updatePhase.mock.invocationCallOrder[0];
      const statusCallOrder = queue.updateStatus.mock.invocationCallOrder[0];
      expect(phaseCallOrder).toBeLessThan(statusCallOrder);
    });

    it('merging phase with commit + validation failure → updates mergePhase to reverted (#464)', async () => {
      const entry = makeEntry({ mergePhase: 'merging', mergeCommit: 'abc123' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry]);

      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(err(new Error('tests failed')));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // Should advance to validating, then revert on failure
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'validating');
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'reverted');
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-1', 'failed', 'tests failed');
    });

    it('validating phase + validation failure does not block queue selection (#464)', async () => {
      const failedEntry = makeEntry({ id: 'entry-1', mergePhase: 'validating', mergeCommit: 'abc123' });
      const queuedEntry = makeEntry({ id: 'entry-2', mergePhase: 'queued', status: 'queued' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([failedEntry, queuedEntry]);

      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(err(new Error('tests failed')));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // After recovery, entry-1 should have mergePhase 'reverted', not 'validating'
      // This ensures selectNext() won't be blocked by the failed entry
      expect(queue.updatePhase).toHaveBeenCalledWith('entry-1', 'reverted');
    });
  });

  describe('recoverStuckEntries Result checking', () => {
    it('updateStatus failure during validating recovery → skips entry', async () => {
      const entry1 = makeEntry({ id: 'entry-1', mergePhase: 'validating' });
      const entry2 = makeEntry({ id: 'entry-2', mergePhase: 'reverted' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry1, entry2]);

      // validate succeeds for entry-1, but updateStatus('merged') fails
      (deps.validate as ReturnType<typeof vi.fn>).mockResolvedValue(ok(undefined));
      queue.updateStatus
        .mockResolvedValueOnce(err(new Error('write failed'))) // entry-1 merged fails
        .mockResolvedValueOnce(ok(undefined)); // entry-2 should still be processed

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // entry-2 should still be processed despite entry-1's updateStatus failure
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-2', 'failed', 'recovered after crash in reverted phase');
    });

    it('updatePhase failure during queued reset → skips entry', async () => {
      const entry1 = makeEntry({ id: 'entry-1', mergePhase: 'rebasing', mergeCommit: null });
      const entry2 = makeEntry({ id: 'entry-2', mergePhase: 'reverted' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry1, entry2]);

      // updatePhase('queued') fails for entry-1
      queue.updatePhase.mockResolvedValueOnce(err(new Error('write failed')));
      queue.updateStatus.mockResolvedValue(ok(undefined));

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // entry-2 should still be processed
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-2', 'failed', 'recovered after crash in reverted phase');
    });

    it('updateStatus failure during reverted recovery → skips entry', async () => {
      const entry1 = makeEntry({ id: 'entry-1', mergePhase: 'reverted' });
      const entry2 = makeEntry({ id: 'entry-2', mergePhase: 'reverted' });
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.list.mockResolvedValue([entry1, entry2]);

      queue.updateStatus
        .mockResolvedValueOnce(err(new Error('write failed'))) // entry-1 fails
        .mockResolvedValueOnce(ok(undefined)); // entry-2 succeeds

      const agent = createMergeAgent(deps, defaultConfig);
      await agent.recoverStuckEntries();

      // Both entries attempted
      expect(queue.updateStatus).toHaveBeenCalledTimes(2);
      expect(queue.updateStatus).toHaveBeenCalledWith('entry-2', 'failed', 'recovered after crash in reverted phase');
    });
  });

  describe('start/stop poll loop', () => {
    it('calls recoverStuckEntries on each tick (#271)', async () => {
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.selectNext.mockResolvedValue(null);
      queue.list.mockResolvedValue([]); // no stuck entries

      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      // Advance past first tick
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);

      // recoverStuckEntries reads queue.list internally
      expect(queue.list).toHaveBeenCalled();

      // Advance past second tick
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);

      expect(queue.list).toHaveBeenCalledTimes(2);

      stop();
    });

    it('recovers stuck entry before processing new entries (#271)', async () => {
      const stuckEntry = makeEntry({ id: 'stuck-1', mergePhase: 'reverted' });
      const newEntry = makeEntry({ id: 'new-1', mergePhase: 'queued' });
      const deps = makeDeps();
      const queue = deps.queue as any;

      // list returns stuck entry for recovery
      queue.list.mockResolvedValue([stuckEntry]);
      // selectNext returns new entry for processing
      queue.selectNext.mockResolvedValueOnce(newEntry).mockResolvedValue(null);
      queue.getEntry.mockResolvedValue(newEntry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock.mockResolvedValue(ok('abc123'));

      const callOrder: string[] = [];
      queue.updateStatus.mockImplementation(async (id: string, status: string) => {
        callOrder.push(`updateStatus:${id}:${status}`);
        return ok(undefined);
      });

      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);

      // Recovery should happen before new entry processing
      expect(callOrder[0]).toBe('updateStatus:stuck-1:failed');

      stop();
    });

    it('polls for entries and processes them', async () => {
      const entry = makeEntry();
      const deps = makeDeps();
      const queue = deps.queue as any;

      // First call returns entry, subsequent calls return null
      queue.selectNext
        .mockResolvedValueOnce(entry)
        .mockResolvedValue(null);
      queue.getEntry.mockResolvedValue(entry);

      const gitMock = deps.git as ReturnType<typeof vi.fn>;
      gitMock.mockResolvedValue(ok('abc123'));

      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      // Advance past first tick
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);

      expect(queue.selectNext).toHaveBeenCalled();

      stop();
    });

    it('stop clears the interval', async () => {
      const deps = makeDeps();
      const queue = deps.queue as any;
      queue.selectNext.mockResolvedValue(null);

      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      // Advance to trigger first tick
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);
      const callCount = queue.selectNext.mock.calls.length;

      stop();

      // Advance more — should not trigger additional calls
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs * 5);
      expect(queue.selectNext.mock.calls.length).toBe(callCount);
    });

    it('applies exponential backoff on error', async () => {
      const deps = makeDeps();
      const queue = deps.queue as any;

      queue.selectNext.mockRejectedValueOnce(new Error('db error'));
      queue.selectNext.mockResolvedValue(null);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      // First tick at pollIntervalMs — triggers error
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);
      expect(queue.selectNext).toHaveBeenCalledTimes(1);

      // Next tick should be at 2x interval due to backoff
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);
      // Should NOT have fired yet (backoff = 200ms, we only advanced 110ms total after error)
      // Actually, let's just advance enough for the doubled interval
      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs);
      expect(queue.selectNext).toHaveBeenCalledTimes(2);

      consoleSpy.mockRestore();
      stop();
    });

    it('logs tick errors to console.error instead of swallowing silently (#389)', async () => {
      const deps = makeDeps();
      const queue = deps.queue as any;

      const saveError = new Error('disk write failed');
      queue.checkDependencyTimeouts.mockRejectedValueOnce(saveError);
      queue.checkDependencyTimeouts.mockResolvedValue([]);
      queue.selectNext.mockResolvedValue(null);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const agent = createMergeAgent(deps, defaultConfig);
      const stop = agent.start();

      await vi.advanceTimersByTimeAsync(defaultConfig.pollIntervalMs + 10);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[merge-agent] tick error:',
        'disk write failed',
      );

      consoleSpy.mockRestore();
      stop();
    });
  });
});
