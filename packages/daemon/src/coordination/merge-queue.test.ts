// src/coordination/merge-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMergeQueue } from './merge-queue.js';
import type { MergeQueue } from './merge-queue.js';

describe('merge-queue', () => {
  let stateDir: string;
  let queue: MergeQueue;

  const makeInput = (overrides: Record<string, unknown> = {}) => ({
    prNumber: 101,
    claimId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    issueNumber: 1,
    headRef: 'feat/test',
    batchId: null as string | null,
    priority: 0,
    ...overrides,
  });

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'merge-queue-'));
    await mkdir(join(stateDir, 'coordination'), { recursive: true });
    queue = createMergeQueue(stateDir);
  });

  describe('enqueue', () => {
    it('creates entry with correct defaults', async () => {
      const entry = await queue.enqueue(makeInput());
      expect(entry.id).toBeDefined();
      expect(entry.mergePhase).toBe('queued');
      expect(entry.status).toBe('queued');
      expect(entry.attempts).toBe(0);
      expect(entry.mergeCommit).toBeNull();
      expect(entry.lastFailureReason).toBeNull();
      expect(entry.prNumber).toBe(101);
      expect(entry.createdAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
    });

    it('persists entry to disk', async () => {
      await queue.enqueue(makeInput());
      const entries = await queue.list();
      expect(entries).toHaveLength(1);
    });
  });

  describe('selectNext', () => {
    it('returns highest priority entry (lower number = higher priority)', async () => {
      await queue.enqueue(makeInput({ prNumber: 1, priority: 10 }));
      await queue.enqueue(makeInput({ prNumber: 2, priority: 1 }));
      await queue.enqueue(makeInput({ prNumber: 3, priority: 5 }));

      const next = await queue.selectNext();
      expect(next).not.toBeNull();
      expect(next!.prNumber).toBe(2);
    });

    it('returns FIFO when same priority', async () => {
      await queue.enqueue(makeInput({ prNumber: 1, priority: 0 }));
      await queue.enqueue(makeInput({ prNumber: 2, priority: 0 }));

      const next = await queue.selectNext();
      expect(next).not.toBeNull();
      expect(next!.prNumber).toBe(1);
    });

    it('returns null when queue is empty', async () => {
      const next = await queue.selectNext();
      expect(next).toBeNull();
    });

    it('returns null when all entries are non-queued', async () => {
      const entry = await queue.enqueue(makeInput());
      await queue.updateStatus(entry.id, 'merged');

      const next = await queue.selectNext();
      expect(next).toBeNull();
    });

    it('skips entries with unsatisfied dependencies', async () => {
      const batchId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const depClaimId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const mainClaimId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

      // Entry A: no deps, part of batch
      await queue.enqueue(makeInput({
        prNumber: 1,
        batchId,
        claimId: depClaimId,
        priority: 10,
      }));

      // Entry B: depends on entry A (same batch, lower priority)
      // The dependency is identified by claimId within the same batch
      // Entry B should not be selected because entry A is not yet merged
      await queue.enqueue(makeInput({
        prNumber: 2,
        batchId,
        claimId: mainClaimId,
        priority: 0,
        dependencies: [depClaimId],
      }));

      // selectNext should pick entry A (priority 10) because entry B (priority 0)
      // has unsatisfied deps — entry A is not merged yet
      const next = await queue.selectNext();
      expect(next).not.toBeNull();
      expect(next!.prNumber).toBe(1);
    });

    it('returns null when active merge exists (single-active lock)', async () => {
      const entry = await queue.enqueue(makeInput({ prNumber: 1 }));
      await queue.updatePhase(entry.id, 'rebasing');

      await queue.enqueue(makeInput({ prNumber: 2 }));

      const next = await queue.selectNext();
      expect(next).toBeNull();
    });
  });

  describe('updatePhase', () => {
    it('changes phase', async () => {
      const entry = await queue.enqueue(makeInput());
      const result = await queue.updatePhase(entry.id, 'rebasing');
      expect(result.ok).toBe(true);

      const updated = await queue.getEntry(entry.id);
      expect(updated!.mergePhase).toBe('rebasing');
    });

    it('returns err for unknown entry', async () => {
      const result = await queue.updatePhase('nonexistent', 'rebasing');
      expect(result.ok).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('changes status', async () => {
      const entry = await queue.enqueue(makeInput());
      const result = await queue.updateStatus(entry.id, 'merged');
      expect(result.ok).toBe(true);

      const updated = await queue.getEntry(entry.id);
      expect(updated!.status).toBe('merged');
    });

    it('stores failure reason', async () => {
      const entry = await queue.enqueue(makeInput());
      await queue.updateStatus(entry.id, 'failed', 'merge conflict');

      const updated = await queue.getEntry(entry.id);
      expect(updated!.status).toBe('failed');
      expect(updated!.lastFailureReason).toBe('merge conflict');
    });

    it('returns err for unknown entry', async () => {
      const result = await queue.updateStatus('nonexistent', 'merged');
      expect(result.ok).toBe(false);
    });
  });

  describe('setMergeCommit', () => {
    it('sets the commit SHA', async () => {
      const entry = await queue.enqueue(makeInput());
      const result = await queue.setMergeCommit(entry.id, 'abc123');
      expect(result.ok).toBe(true);

      const updated = await queue.getEntry(entry.id);
      expect(updated!.mergeCommit).toBe('abc123');
    });

    it('returns err for unknown entry', async () => {
      const result = await queue.setMergeCommit('nonexistent', 'abc123');
      expect(result.ok).toBe(false);
    });
  });

  describe('incrementAttempts', () => {
    it('increments count', async () => {
      const entry = await queue.enqueue(makeInput());
      expect(entry.attempts).toBe(0);

      await queue.incrementAttempts(entry.id);
      const updated1 = await queue.getEntry(entry.id);
      expect(updated1!.attempts).toBe(1);

      await queue.incrementAttempts(entry.id);
      const updated2 = await queue.getEntry(entry.id);
      expect(updated2!.attempts).toBe(2);
    });

    it('returns err for unknown entry', async () => {
      const result = await queue.incrementAttempts('nonexistent');
      expect(result.ok).toBe(false);
    });
  });

  describe('hasActiveMerge', () => {
    it('returns false when no entries', async () => {
      expect(await queue.hasActiveMerge()).toBe(false);
    });

    it('returns false when all entries are queued', async () => {
      await queue.enqueue(makeInput());
      expect(await queue.hasActiveMerge()).toBe(false);
    });

    it('returns true when entry in active phase', async () => {
      const entry = await queue.enqueue(makeInput());
      await queue.updatePhase(entry.id, 'merging');
      expect(await queue.hasActiveMerge()).toBe(true);
    });

    it('returns true for rebasing phase', async () => {
      const entry = await queue.enqueue(makeInput());
      await queue.updatePhase(entry.id, 'rebasing');
      expect(await queue.hasActiveMerge()).toBe(true);
    });

    it('returns true for validating phase', async () => {
      const entry = await queue.enqueue(makeInput());
      await queue.updatePhase(entry.id, 'validating');
      expect(await queue.hasActiveMerge()).toBe(true);
    });
  });

  describe('checkDependencyTimeouts', () => {
    it('marks old queued entries with unsatisfied deps as blocked', async () => {
      const batchId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const depClaimId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

      // Create dependency entry (not merged)
      await queue.enqueue(makeInput({
        prNumber: 1,
        batchId,
        claimId: depClaimId,
      }));

      // Create entry that depends on the above
      const dependent = await queue.enqueue(makeInput({
        prNumber: 2,
        batchId,
        claimId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        dependencies: [depClaimId],
      }));

      // Use a timeout of 0ms so it triggers immediately
      const blockedIds = await queue.checkDependencyTimeouts(0);
      expect(blockedIds).toContain(dependent.id);

      const updated = await queue.getEntry(dependent.id);
      expect(updated!.status).toBe('blocked');
    });

    it('does not block entries without dependencies', async () => {
      await queue.enqueue(makeInput());
      const blockedIds = await queue.checkDependencyTimeouts(0);
      expect(blockedIds).toHaveLength(0);
    });

    it('does not block entries whose deps are satisfied', async () => {
      const batchId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const depClaimId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

      const dep = await queue.enqueue(makeInput({
        prNumber: 1,
        batchId,
        claimId: depClaimId,
      }));
      await queue.updateStatus(dep.id, 'merged');

      await queue.enqueue(makeInput({
        prNumber: 2,
        batchId,
        claimId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        dependencies: [depClaimId],
      }));

      const blockedIds = await queue.checkDependencyTimeouts(0);
      expect(blockedIds).toHaveLength(0);
    });
  });

  describe('getEntry', () => {
    it('returns null for unknown entry', async () => {
      const entry = await queue.getEntry('nonexistent');
      expect(entry).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all entries', async () => {
      await queue.enqueue(makeInput({ prNumber: 1 }));
      await queue.enqueue(makeInput({ prNumber: 2 }));
      const entries = await queue.list();
      expect(entries).toHaveLength(2);
    });
  });
});
