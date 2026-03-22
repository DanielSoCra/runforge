// src/coordination/batch-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBatchManager, type BatchManager } from './batch-manager.js';

describe('batch-manager', () => {
  let stateDir: string;
  let mgr: BatchManager;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'batch-mgr-'));
    await mkdir(join(stateDir, 'coordination'), { recursive: true });
    mgr = createBatchManager(stateDir);
  });

  // 1. Create batch with items and dependencies
  it('creates a batch with items and dependencies', async () => {
    const batch = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [] },
      ],
      3,
      500,
    );

    expect(batch.status).toBe('planning');
    expect(batch.items).toHaveLength(2);
    expect(batch.targetWorkerCount).toBe(3);
    expect(batch.budgetEstimate).toBe(500);
    expect(batch.items[0]!.issueNumber).toBe(1);
    expect(batch.items[0]!.status).toBe('pending');
    expect(batch.items[1]!.issueNumber).toBe(2);
  });

  // 2. Transition planning -> active
  it('transitions planning -> active via finalize', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    const result = await mgr.transition(batch.id, 'finalize');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
      expect(result.value.activatedAt).not.toBeNull();
    }
  });

  // 3. Transition active -> completed
  it('transitions active -> completed via all_merged', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');
    const result = await mgr.transition(batch.id, 'all_merged');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('completed');
      expect(result.value.completedAt).not.toBeNull();
    }
  });

  // 4. Transition active -> cancelled
  it('transitions active -> cancelled via cancel', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');
    const result = await mgr.transition(batch.id, 'cancel');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('cancelled');
    }
  });

  // 5. Invalid transition returns error (planning -> completed)
  it('returns error for invalid transition (planning -> completed)', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    const result = await mgr.transition(batch.id, 'all_merged');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid transition');
    }
  });

  // 5b. Terminal states have no transitions
  it('returns error when transitioning from terminal state', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');
    await mgr.transition(batch.id, 'all_merged');

    const result = await mgr.transition(batch.id, 'cancel');
    expect(result.ok).toBe(false);
  });

  // 6. Only one active batch at a time
  it('prevents creating a batch when one is already active', async () => {
    const batch1 = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch1.id, 'finalize');

    await expect(
      mgr.create([{ issueNumber: 2, dependencies: [] }], 1, 100),
    ).rejects.toThrow('active batch already exists');
  });

  // 7. getReadySet returns items with all deps satisfied
  it('getReadySet returns pending items with no dependencies', async () => {
    const batch = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [] },
      ],
      2,
      200,
    );
    await mgr.transition(batch.id, 'finalize');

    const ready = await mgr.getReadySet(batch.id);
    expect(ready).toHaveLength(2);
  });

  it('getReadySet returns dep-item when dependency is completed', async () => {
    // Create batch with 2 items, then cancel and recreate with real deps
    const seed = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [] },
      ],
      2,
      200,
    );
    // Note the item IDs won't carry over, but we can use a fake UUID for dep testing

    await mgr.transition(seed.id, 'finalize');
    await mgr.transition(seed.id, 'cancel');

    // Create batch where item 2 depends on item 1 (use item 1's ID as dep)
    // Since IDs are generated at creation time, we use a fresh batch
    const batch = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [] },
      ],
      2,
      200,
    );
    const item1Id = batch.items[0]!.id;

    // Cancel and recreate with item2 depending on item1Id
    // But item1Id is from a different batch instance...
    // The cleanest way: create with dep, finalize, then mark dep as completed
    await mgr.transition(batch.id, 'finalize');
    await mgr.transition(batch.id, 'cancel');

    const batch2 = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: ['will-be-replaced'] },
      ],
      2,
      200,
    );
    // Replace the dep with item1's actual ID from this batch
    const realItem1Id = batch2.items[0]!.id;
    // We need to update the dep in storage. Let's use a workaround:
    // Read the file, modify, and write back.
    const { readJsonSafe, writeJsonSafe } = await import('../lib/json-store.js');
    const batchesPath = join(stateDir, 'coordination', 'batches.json');
    const result = await readJsonSafe<any[]>(batchesPath);
    if (result.ok) {
      const b = result.value.find((x: any) => x.id === batch2.id);
      b.items[1].dependencies = [realItem1Id];
      await writeJsonSafe(batchesPath, result.value);
    }

    await mgr.transition(batch2.id, 'finalize');

    // Item 1 is pending with no deps -> ready
    // Item 2 is pending but depends on item 1 (pending, not terminal) -> NOT ready
    let ready = await mgr.getReadySet(batch2.id);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.issueNumber).toBe(1);

    // Mark item 1 as completed -> item 2 should now be ready
    await mgr.updateItemStatus(batch2.id, realItem1Id, 'completed');
    ready = await mgr.getReadySet(batch2.id);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.issueNumber).toBe(2);
  });

  // 8. getReadySet excludes items with unsatisfied deps
  it('getReadySet excludes items with unsatisfied deps', async () => {
    const fakeDepId = '00000000-0000-0000-0000-000000000001';
    const batch = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [fakeDepId] },
      ],
      2,
      200,
    );
    await mgr.transition(batch.id, 'finalize');

    const ready = await mgr.getReadySet(batch.id);
    // Item 1: no deps, pending -> ready
    // Item 2: dep on unknown ID -> not ready
    expect(ready).toHaveLength(1);
    expect(ready[0]!.issueNumber).toBe(1);
  });

  it('getReadySet excludes non-pending items', async () => {
    const batch = await mgr.create(
      [
        { issueNumber: 1, dependencies: [] },
        { issueNumber: 2, dependencies: [] },
      ],
      2,
      200,
    );
    await mgr.transition(batch.id, 'finalize');
    await mgr.updateItemStatus(batch.id, batch.items[0]!.id, 'in_progress');

    const ready = await mgr.getReadySet(batch.id);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.issueNumber).toBe(2);
  });

  // 9. updateItemStatus changes item status
  it('updateItemStatus changes item status', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');

    const result = await mgr.updateItemStatus(batch.id, batch.items[0]!.id, 'in_progress');
    expect(result.ok).toBe(true);

    const active = await mgr.getActive();
    expect(active).not.toBeNull();
    expect(active!.items[0]!.status).toBe('in_progress');
  });

  it('updateItemStatus returns error for unknown batch', async () => {
    const result = await mgr.updateItemStatus(
      '00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000001',
      'in_progress',
    );
    expect(result.ok).toBe(false);
  });

  it('updateItemStatus returns error for unknown item', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    const result = await mgr.updateItemStatus(
      batch.id,
      '00000000-0000-0000-0000-000000000099',
      'in_progress',
    );
    expect(result.ok).toBe(false);
  });

  // 10. getActive returns the active batch or null
  it('getActive returns null when no active batch', async () => {
    const active = await mgr.getActive();
    expect(active).toBeNull();
  });

  it('getActive returns the active batch', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');

    const active = await mgr.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(batch.id);
    expect(active!.status).toBe('active');
  });

  it('getActive returns null after batch is completed', async () => {
    const batch = await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    await mgr.transition(batch.id, 'finalize');
    await mgr.transition(batch.id, 'all_merged');

    const active = await mgr.getActive();
    expect(active).toBeNull();
  });

  // list
  it('list returns all batches', async () => {
    await mgr.create([{ issueNumber: 1, dependencies: [] }], 1, 100);
    const batches = await mgr.list();
    expect(batches).toHaveLength(1);
  });

  it('transition returns error for unknown batch', async () => {
    const result = await mgr.transition('00000000-0000-0000-0000-000000000000', 'finalize');
    expect(result.ok).toBe(false);
  });
});
