// src/coordination/merge-queue.ts — Merge queue: enqueue, select, update, persist
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import type { MergePhase, MergeQueueEntry, MergeStatus } from './types.js';
import type { Result } from '../lib/result.js';
import { ok, err } from '../lib/result.js';
import { readJsonSafe, writeJsonSafe } from '../lib/json-store.js';

const ACTIVE_PHASES: MergePhase[] = ['rebasing', 'merging', 'validating'];

export interface MergeQueue {
  enqueue(entry: Omit<MergeQueueEntry, 'id' | 'dependencies' | 'mergePhase' | 'status' | 'mergeCommit' | 'attempts' | 'lastFailureReason' | 'createdAt' | 'updatedAt'> & { dependencies?: string[] }): Promise<MergeQueueEntry>;
  selectNext(): Promise<MergeQueueEntry | null>;
  updatePhase(entryId: string, phase: MergePhase): Promise<Result<void>>;
  updateStatus(entryId: string, status: MergeStatus, reason?: string): Promise<Result<void>>;
  setMergeCommit(entryId: string, commitSha: string): Promise<Result<void>>;
  incrementAttempts(entryId: string): Promise<Result<void>>;
  getEntry(entryId: string): Promise<MergeQueueEntry | null>;
  list(): Promise<MergeQueueEntry[]>;
  hasActiveMerge(): Promise<boolean>;
  checkDependencyTimeouts(timeoutMs: number): Promise<string[]>;
}

export function createMergeQueue(stateDir: string): MergeQueue {
  const queuePath = join(stateDir, 'coordination', 'merge-queue.json');

  async function load(): Promise<MergeQueueEntry[]> {
    const result = await readJsonSafe<MergeQueueEntry[]>(queuePath);
    return result.ok ? result.value : [];
  }

  async function save(entries: MergeQueueEntry[]): Promise<void> {
    await mkdir(join(stateDir, 'coordination'), { recursive: true });
    await writeJsonSafe(queuePath, entries);
  }

  async function findAndUpdate(
    entryId: string,
    updater: (entry: MergeQueueEntry) => MergeQueueEntry,
  ): Promise<Result<void>> {
    const entries = await load();
    const idx = entries.findIndex((e) => e.id === entryId);
    if (idx === -1) return err(new Error(`Entry not found: ${entryId}`));
    entries[idx] = updater(entries[idx]!);
    await save(entries);
    return ok(undefined);
  }

  function hasSatisfiedDeps(entry: MergeQueueEntry, allEntries: MergeQueueEntry[]): boolean {
    if (!entry.dependencies || entry.dependencies.length === 0) return true;
    if (!entry.batchId) return true;

    for (const depClaimId of entry.dependencies) {
      const depEntry = allEntries.find(
        (e) => e.claimId === depClaimId && e.batchId === entry.batchId,
      );
      if (!depEntry || depEntry.status !== 'merged') return false;
    }
    return true;
  }

  return {
    async enqueue(input) {
      const now = new Date().toISOString();
      const entry: MergeQueueEntry = {
        ...input,
        dependencies: input.dependencies ?? [],
        id: randomUUID(),
        mergePhase: 'queued',
        status: 'queued',
        mergeCommit: null,
        attempts: 0,
        lastFailureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      const entries = await load();
      entries.push(entry);
      await save(entries);
      return entry;
    },

    async selectNext() {
      const entries = await load();

      // Single-active-entry lock
      const hasActive = entries.some((e) => ACTIVE_PHASES.includes(e.mergePhase));
      if (hasActive) return null;

      const candidates = entries
        .filter((e) => e.status === 'queued' && e.mergePhase === 'queued')
        .filter((e) => hasSatisfiedDeps(e, entries));

      if (candidates.length === 0) return null;

      // Sort by priority (lower first), then by createdAt (FIFO)
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });

      return candidates[0]!;
    },

    async updatePhase(entryId, phase) {
      return findAndUpdate(entryId, (e) => ({
        ...e,
        mergePhase: phase,
        updatedAt: new Date().toISOString(),
      }));
    },

    async updateStatus(entryId, status, reason) {
      return findAndUpdate(entryId, (e) => ({
        ...e,
        status,
        lastFailureReason: reason ?? e.lastFailureReason,
        updatedAt: new Date().toISOString(),
      }));
    },

    async setMergeCommit(entryId, commitSha) {
      return findAndUpdate(entryId, (e) => ({
        ...e,
        mergeCommit: commitSha,
        updatedAt: new Date().toISOString(),
      }));
    },

    async incrementAttempts(entryId) {
      return findAndUpdate(entryId, (e) => ({
        ...e,
        attempts: e.attempts + 1,
        updatedAt: new Date().toISOString(),
      }));
    },

    async getEntry(entryId) {
      const entries = await load();
      return entries.find((e) => e.id === entryId) ?? null;
    },

    async list() {
      return load();
    },

    async hasActiveMerge() {
      const entries = await load();
      return entries.some((e) => ACTIVE_PHASES.includes(e.mergePhase));
    },

    async checkDependencyTimeouts(timeoutMs) {
      const entries = await load();
      const now = Date.now();
      const blockedIds: string[] = [];

      for (const entry of entries) {
        if (entry.status !== 'queued' || entry.mergePhase !== 'queued') continue;
        if (!entry.dependencies || entry.dependencies.length === 0) continue;
        if (hasSatisfiedDeps(entry, entries)) continue;

        const createdMs = new Date(entry.createdAt).getTime();
        if (now - createdMs >= timeoutMs) {
          entry.status = 'blocked';
          entry.updatedAt = new Date().toISOString();
          blockedIds.push(entry.id);
        }
      }

      if (blockedIds.length > 0) {
        await save(entries);
      }

      return blockedIds;
    },
  };
}
