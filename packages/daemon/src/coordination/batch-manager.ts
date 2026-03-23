// src/coordination/batch-manager.ts — Batch state machine with dependency graph
import { randomUUID } from 'crypto';
import { join } from 'path';
import { ok, err, type Result } from '../lib/result.js';
import { writeJsonSafe, readJsonSafe } from '../lib/json-store.js';
import {
  type Batch,
  BatchSchema,
  type BatchItem,
  type BatchStatus,
  type BatchEvent,
  type BatchItemStatus,
  batchTransitions,
  isTerminalSatisfied,
} from './types.js';

export interface BatchManager {
  create(
    items: Array<{ issueNumber: number; repoKey?: string; dependencies: string[] }>,
    targetWorkerCount: number,
    budgetEstimate: number,
  ): Promise<Batch>;
  transition(batchId: string, event: BatchEvent): Promise<Result<Batch>>;
  getActive(): Promise<Batch | null>;
  getReadySet(batchId: string): Promise<BatchItem[]>;
  updateItemStatus(batchId: string, itemId: string, status: BatchItemStatus): Promise<Result<void>>;
  list(): Promise<Batch[]>;
}

export function createBatchManager(stateDir: string): BatchManager {
  const batchesPath = join(stateDir, 'coordination', 'batches.json');

  async function loadBatches(): Promise<Batch[]> {
    const result = await readJsonSafe<Batch[]>(batchesPath);
    if (result.ok) return result.value;
    return [];
  }

  async function saveBatches(batches: Batch[]): Promise<void> {
    await writeJsonSafe(batchesPath, batches);
  }

  return {
    async create(items, targetWorkerCount, budgetEstimate): Promise<Batch> {
      const batches = await loadBatches();

      // Only one active batch at a time
      const activeBatch = batches.find((b) => b.status === 'active');
      if (activeBatch) {
        throw new Error('active batch already exists');
      }

      const now = new Date().toISOString();
      const batch: Batch = {
        id: randomUUID(),
        status: 'planning',
        targetWorkerCount,
        budgetEstimate,
        items: items.map((item) => ({
          id: randomUUID(),
          issueNumber: item.issueNumber,
          repoKey: item.repoKey,
          status: 'pending' as const,
          dependencies: item.dependencies,
        })),
        createdAt: now,
        activatedAt: null,
        completedAt: null,
      };

      batches.push(batch);
      await saveBatches(batches);
      return batch;
    },

    async transition(batchId, event): Promise<Result<Batch>> {
      const batches = await loadBatches();
      const batch = batches.find((b) => b.id === batchId);
      if (!batch) {
        return err(new Error(`Batch not found: ${batchId}`));
      }

      const transitions = batchTransitions[batch.status];
      const nextStatus = transitions[event];
      if (!nextStatus) {
        return err(
          new Error(
            `Invalid transition: cannot apply '${event}' to batch in '${batch.status}' state`,
          ),
        );
      }

      batch.status = nextStatus;
      const now = new Date().toISOString();
      if (nextStatus === 'active') {
        batch.activatedAt = now;
      }
      if (nextStatus === 'completed' || nextStatus === 'cancelled') {
        batch.completedAt = now;
      }

      try {
        await saveBatches(batches);
      } catch (e) {
        return err(new Error(`Failed to save batch after transition: ${e instanceof Error ? e.message : String(e)}`));
      }
      return ok(batch);
    },

    async getActive(): Promise<Batch | null> {
      const batches = await loadBatches();
      return batches.find((b) => b.status === 'active') ?? null;
    },

    async getReadySet(batchId): Promise<BatchItem[]> {
      const batches = await loadBatches();
      const batch = batches.find((b) => b.id === batchId);
      if (!batch) return [];

      const itemMap = new Map<string, BatchItem>();
      for (const item of batch.items) {
        itemMap.set(item.id, item);
      }

      return batch.items.filter((item) => {
        // Only pending items can be in the ready set
        if (item.status !== 'pending') return false;

        // All dependencies must be terminal-satisfied
        return item.dependencies.every((depId) => {
          const dep = itemMap.get(depId);
          if (!dep) return false; // unknown dep = unsatisfied
          return isTerminalSatisfied(dep.status);
        });
      });
    },

    async updateItemStatus(batchId, itemId, status): Promise<Result<void>> {
      const batches = await loadBatches();
      const batch = batches.find((b) => b.id === batchId);
      if (!batch) {
        return err(new Error(`Batch not found: ${batchId}`));
      }

      const item = batch.items.find((i) => i.id === itemId);
      if (!item) {
        return err(new Error(`BatchItem not found: ${itemId}`));
      }

      item.status = status;
      try {
        await saveBatches(batches);
      } catch (e) {
        return err(new Error(`Failed to save batch after item status update: ${e instanceof Error ? e.message : String(e)}`));
      }
      return ok(undefined);
    },

    async list(): Promise<Batch[]> {
      return loadBatches();
    },
  };
}
