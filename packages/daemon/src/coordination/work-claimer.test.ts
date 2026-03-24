// src/coordination/work-claimer.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkClaimer } from './work-claimer.js';
import type { WorkClaimer } from './work-claimer.js';

describe('work-claimer', () => {
  let stateDir: string;
  let claimer: WorkClaimer;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'work-claimer-'));
    claimer = createWorkClaimer(stateDir);
  });

  describe('claim', () => {
    it('succeeds for a new issue', async () => {
      const result = await claimer.claim(42, 'worker');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.issueNumber).toBe(42);
      expect(result.value.agentType).toBe('worker');
      expect(result.value.status).toBe('claimed');
      expect(result.value.attempt).toBe(1);
      expect(result.value.id).toBeDefined();
    });

    it('fails if issue already has an active claim', async () => {
      const first = await claimer.claim(42, 'worker');
      expect(first.ok).toBe(true);

      const second = await claimer.claim(42, 'worker');
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.message).toMatch(/active claim/i);
    });

    it('succeeds if previous claim is in terminal status (completed)', async () => {
      const first = await claimer.claim(42, 'worker');
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await claimer.updateStatus(first.value.id, 'completed');

      const second = await claimer.claim(42, 'worker');
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.attempt).toBe(2);
      expect(second.value.issueNumber).toBe(42);
    });

    it('succeeds if previous claim is in terminal status (failed)', async () => {
      const first = await claimer.claim(42, 'worker');
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await claimer.updateStatus(first.value.id, 'failed', 'something broke');

      const second = await claimer.claim(42, 'worker');
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.attempt).toBe(2);
    });

    it('stores batchItemId when provided', async () => {
      const batchItemId = '00000000-0000-0000-0000-000000000001';
      const result = await claimer.claim(42, 'worker', batchItemId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.batchItemId).toBe(batchItemId);
    });
  });

  describe('findActiveClaim', () => {
    it('returns the active claim for an issue', async () => {
      const result = await claimer.claim(42, 'worker');
      expect(result.ok).toBe(true);

      const active = await claimer.findActiveClaim(42);
      expect(active).not.toBeNull();
      expect(active!.issueNumber).toBe(42);
      expect(active!.status).toBe('claimed');
    });

    it('returns null when no active claim exists', async () => {
      const active = await claimer.findActiveClaim(99);
      expect(active).toBeNull();
    });

    it('returns null when only terminal claims exist', async () => {
      const result = await claimer.claim(42, 'worker');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await claimer.updateStatus(result.value.id, 'completed');

      const active = await claimer.findActiveClaim(42);
      expect(active).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('transitions claim status', async () => {
      const result = await claimer.claim(42, 'worker');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const updated = await claimer.updateStatus(result.value.id, 'in_progress');
      expect(updated.ok).toBe(true);

      const active = await claimer.findActiveClaim(42);
      expect(active).not.toBeNull();
      expect(active!.status).toBe('in_progress');
    });

    it('stores failure reason when provided', async () => {
      const result = await claimer.claim(42, 'worker');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      await claimer.updateStatus(result.value.id, 'failed', 'timeout');

      const all = await claimer.listAll();
      const claim = all.find((c) => c.id === result.value.id);
      expect(claim).toBeDefined();
      expect(claim!.failureReason).toBe('timeout');
    });

    it('returns error for non-existent claim', async () => {
      const result = await claimer.updateStatus('00000000-0000-0000-0000-000000000099', 'completed');
      expect(result.ok).toBe(false);
    });
  });

  describe('listActive', () => {
    it('returns only active claims', async () => {
      const r1 = await claimer.claim(1, 'worker');
      const r2 = await claimer.claim(2, 'worker');
      const r3 = await claimer.claim(3, 'worker');
      expect(r1.ok && r2.ok && r3.ok).toBe(true);
      if (!r1.ok || !r2.ok || !r3.ok) return;

      await claimer.updateStatus(r2.value.id, 'completed');

      const active = await claimer.listActive();
      expect(active).toHaveLength(2);
      expect(active.map((c) => c.issueNumber).sort()).toEqual([1, 3]);
    });
  });

  describe('listAll', () => {
    it('returns all claims including terminal', async () => {
      const r1 = await claimer.claim(1, 'worker');
      const r2 = await claimer.claim(2, 'worker');
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      await claimer.updateStatus(r2.value.id, 'failed', 'error');

      const all = await claimer.listAll();
      expect(all).toHaveLength(2);
      const statuses = all.map((c) => c.status).sort();
      expect(statuses).toEqual(['claimed', 'failed']);
    });
  });
});
