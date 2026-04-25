// src/knowledge/exemplar-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExemplarStore } from './exemplar-store.js';

let dir: string;
let storePath: string;
let store: ExemplarStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exemplar-store-test-'));
  storePath = join(dir, 'exemplars.json');
  store = new ExemplarStore(storePath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ExemplarStore', () => {
  describe('get', () => {
    it('returns undefined when no exemplar exists for type', async () => {
      const result = await store.get('data-model');
      expect(result).toBeUndefined();
    });
  });

  describe('store', () => {
    it('stores a new exemplar when none exists', async () => {
      const stored = await store.store({
        deliverableType: 'data-model',
        branch: 'feat/123',
        commitSha: 'abc123',
        filePaths: ['src/models/user.ts'],
        qualityScore: 8,
        createdAt: new Date().toISOString(),
      });
      expect(stored).toBe(true);

      const result = await store.get('data-model');
      expect(result).toBeDefined();
      expect(result!.commitSha).toBe('abc123');
      expect(result!.qualityScore).toBe(8);
    });

    it('replaces exemplar when new quality score is higher', async () => {
      await store.store({
        deliverableType: 'data-model',
        branch: 'feat/1',
        commitSha: 'old',
        filePaths: ['src/a.ts'],
        qualityScore: 5,
        createdAt: new Date().toISOString(),
      });
      const replaced = await store.store({
        deliverableType: 'data-model',
        branch: 'feat/2',
        commitSha: 'new',
        filePaths: ['src/b.ts'],
        qualityScore: 9,
        createdAt: new Date().toISOString(),
      });
      expect(replaced).toBe(true);

      const result = await store.get('data-model');
      expect(result!.commitSha).toBe('new');
    });

    it('does NOT replace exemplar when new quality score is lower', async () => {
      await store.store({
        deliverableType: 'data-model',
        branch: 'feat/1',
        commitSha: 'high',
        filePaths: ['src/a.ts'],
        qualityScore: 9,
        createdAt: new Date().toISOString(),
      });
      const replaced = await store.store({
        deliverableType: 'data-model',
        branch: 'feat/2',
        commitSha: 'low',
        filePaths: ['src/b.ts'],
        qualityScore: 4,
        createdAt: new Date().toISOString(),
      });
      expect(replaced).toBe(false);

      const result = await store.get('data-model');
      expect(result!.commitSha).toBe('high');
    });
  });

  describe('list', () => {
    it('returns all stored exemplars', async () => {
      await store.store({
        deliverableType: 'data-model',
        branch: 'feat/1',
        commitSha: 'a',
        filePaths: ['src/a.ts'],
        qualityScore: 8,
        createdAt: new Date().toISOString(),
      });
      await store.store({
        deliverableType: 'endpoint',
        branch: 'feat/2',
        commitSha: 'b',
        filePaths: ['src/b.ts'],
        qualityScore: 7,
        createdAt: new Date().toISOString(),
      });

      const all = await store.list();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all['data-model']).toBeDefined();
      expect(all['endpoint']).toBeDefined();
    });

    it('returns empty object when no exemplars exist', async () => {
      const all = await store.list();
      expect(Object.keys(all)).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('survives re-creation from disk', async () => {
      await store.store({
        deliverableType: 'data-model',
        branch: 'feat/1',
        commitSha: 'abc',
        filePaths: ['src/a.ts'],
        qualityScore: 8,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const freshStore = new ExemplarStore(storePath);
      const result = await freshStore.get('data-model');
      expect(result).toBeDefined();
      expect(result!.commitSha).toBe('abc');
    });
  });

  describe('concurrency', () => {
    it('serializes concurrent store() calls (no lost writes) (#297)', async () => {
      // Fire 20 concurrent stores with distinct deliverableType keys.
      // Without a mutex, the read-modify-write cycle in store() races and
      // some writes get clobbered when promises resolve out of order.
      const writes = Array.from({ length: 20 }, (_, i) =>
        store.store({
          deliverableType: `type-${i}`,
          branch: `feat/${i}`,
          commitSha: `sha-${i}`,
          filePaths: [`src/f${i}.ts`],
          qualityScore: 8,
          createdAt: new Date().toISOString(),
        }),
      );
      const results = await Promise.all(writes);
      expect(results.every((r) => r === true)).toBe(true);

      const all = await store.list();
      expect(Object.keys(all)).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        const exemplar = all[`type-${i}`];
        expect(exemplar).toBeDefined();
        expect(exemplar!.commitSha).toBe(`sha-${i}`);
      }
    });
  });
});
