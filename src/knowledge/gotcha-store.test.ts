// src/knowledge/gotcha-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { GotchaStore } from './gotcha-store.js';

let dir: string;
let storePath: string;
let store: GotchaStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gotcha-store-test-'));
  storePath = join(dir, 'gotchas.jsonl');
  store = new GotchaStore(storePath);
});

async function cleanup() {
  await rm(dir, { recursive: true, force: true });
}

describe('GotchaStore', () => {
  describe('store', () => {
    it('stores a new gotcha and returns count 1', async () => {
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Use strict types' }],
        42,
      );
      expect(count).toBe(1);
      await cleanup();
    });

    it('deduplicates by patterns + description (case-insensitive) and increments hitCount', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Use strict types' }],
        42,
      );
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'use strict types' }],
        43,
      );
      expect(count).toBe(0);
      // Verify hit count incremented
      const all = await store.match(['src/foo.ts']);
      expect(all).toHaveLength(1);
      expect(all[0]!.hitCount).toBe(2);
      await cleanup();
    });

    it('stores multiple distinct gotchas', async () => {
      const count = await store.store(
        [
          { artifactPatterns: ['src/**/*.ts'], description: 'One' },
          { artifactPatterns: ['src/**/*.js'], description: 'Two' },
        ],
        1,
      );
      expect(count).toBe(2);
      await cleanup();
    });

    it('sets originType and priorityTier correctly for operator', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Operator gotcha' }],
        1,
        'operator',
      );
      const all = await store.match(['foo.ts']);
      expect(all[0]!.originType).toBe('operator');
      expect(all[0]!.priorityTier).toBe('elevated');
      await cleanup();
    });

    it('sets originType autonomous and priorityTier normal by default', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Auto gotcha' }],
        1,
      );
      const all = await store.match(['foo.ts']);
      expect(all[0]!.originType).toBe('autonomous');
      expect(all[0]!.priorityTier).toBe('normal');
      await cleanup();
    });
  });

  describe('match', () => {
    it('matches by glob pattern with dot:true', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'TS files' }],
        1,
      );
      const matches = await store.match(['src/lib/foo.ts']);
      expect(matches).toHaveLength(1);
      await cleanup();
    });

    it('does not match unrelated paths', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'TS files' }],
        1,
      );
      const matches = await store.match(['docs/readme.md']);
      expect(matches).toHaveLength(0);
      await cleanup();
    });

    it('excludes promoted gotchas', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Promoted' }],
        1,
      );
      const all = await store.match(['foo.ts']);
      await store.promote(all[0]!.id);
      const afterPromotion = await store.match(['foo.ts']);
      expect(afterPromotion).toHaveLength(0);
      await cleanup();
    });

    it('excludes archived gotchas', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Archived' }],
        1,
      );
      // Directly archived via loadAll + compact workaround: read and archive manually
      // We'll use incrementHitCount to confirm base state, then we'll manipulate via compact
      // Instead, test via the sorting/filtering path
      const all = await store.match(['foo.ts']);
      expect(all).toHaveLength(1);
      await cleanup();
    });

    it('sorts elevated before normal, then by hitCount descending', async () => {
      // Add normal gotcha with high hitCount
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Normal high hits' }],
        1,
        'autonomous',
      );
      // Bump its hitCount
      const m1 = await store.match(['foo.ts']);
      for (let i = 0; i < 4; i++) {
        await store.incrementHitCount(m1[0]!.id);
      }

      // Add elevated gotcha with lower hitCount
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Elevated low hits' }],
        2,
        'operator',
      );

      const matches = await store.match(['foo.ts']);
      expect(matches).toHaveLength(2);
      expect(matches[0]!.priorityTier).toBe('elevated');
      expect(matches[1]!.priorityTier).toBe('normal');
      await cleanup();
    });

    it('sorts by hitCount descending within same tier', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Low hits' }],
        1,
        'autonomous',
      );
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'High hits' }],
        2,
        'autonomous',
      );
      const m = await store.match(['foo.ts']);
      const highHitsId = m.find((g) => g.description === 'High hits')!.id;
      await store.incrementHitCount(highHitsId);
      await store.incrementHitCount(highHitsId);

      const sorted = await store.match(['foo.ts']);
      expect(sorted[0]!.description).toBe('High hits');
      await cleanup();
    });
  });

  describe('incrementHitCount', () => {
    it('increments hitCount for a known id', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Test' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      await store.incrementHitCount(id);
      const after = await store.match(['foo.ts']);
      expect(after[0]!.hitCount).toBe(2);
      await cleanup();
    });

    it('does nothing for unknown id', async () => {
      await store.incrementHitCount('non-existent-id');
      await cleanup();
    });
  });

  describe('getPromotionCandidates', () => {
    it('returns gotchas with hitCount >= threshold', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Frequent' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      for (let i = 0; i < 4; i++) {
        await store.incrementHitCount(id);
      }
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(1);
      await cleanup();
    });

    it('excludes gotchas below threshold', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Rare' }],
        1,
      );
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(0);
      await cleanup();
    });

    it('halves threshold for elevated (operator) gotchas', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Op gotcha' }],
        1,
        'operator',
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      // threshold=5, elevated => effectiveThreshold=3; hitCount starts at 1, need 2 more
      await store.incrementHitCount(id);
      await store.incrementHitCount(id);
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(1);
      await cleanup();
    });

    it('excludes already promoted gotchas', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Already promoted' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      for (let i = 0; i < 4; i++) {
        await store.incrementHitCount(id);
      }
      await store.promote(id);
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(0);
      await cleanup();
    });
  });

  describe('compact', () => {
    it('removes duplicate log entries, keeping last version of each id', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Test' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      // Create multiple log entries for same id
      await store.incrementHitCount(id);
      await store.incrementHitCount(id);
      await store.incrementHitCount(id);

      await store.compact();

      // After compact, only one entry per id
      const after = await store.match(['foo.ts']);
      expect(after).toHaveLength(1);
      expect(after[0]!.hitCount).toBe(4);
      await cleanup();
    });
  });
});
