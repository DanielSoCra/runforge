// src/knowledge/gotcha-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GotchaStore', () => {
  describe('store', () => {
    it('stores a new gotcha and returns count 1', async () => {
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Use strict types' }],
        42,
      );
      expect(count).toBe(1);

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
      // Verify hit count: 1 (initial store) + 1 (dedup) + 1 (this match) = 3
      const all = await store.match(['src/foo.ts']);
      expect(all).toHaveLength(1);
      expect(all[0]!.hitCount).toBe(3);

    });

    it('accumulates hitCount correctly across 3+ consecutive store() dedups (#105)', async () => {
      // First store: creates entry with hitCount=1
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Repeated gotcha' }],
        10,
      );

      // Second store (dedup): hitCount should be 2
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'repeated gotcha' }],
        11,
      );

      // Third store (dedup): hitCount should be 3
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Repeated Gotcha' }],
        12,
      );

      // Fourth store (dedup): hitCount should be 4
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'REPEATED GOTCHA' }],
        13,
      );

      // Fifth store (dedup): hitCount should be 5
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'repeated GOTCHA' }],
        14,
      );
      expect(count).toBe(0);

      // Verify: 1 (initial) + 4 (dedups) = 5, then +1 (match) = 6
      const all = await store.match(['src/foo.ts']);
      expect(all).toHaveLength(1);
      expect(all[0]!.hitCount).toBe(6);

      // Verify persistence: re-create store from disk and check
      const freshStore = new GotchaStore(storePath);
      const fromDisk = await freshStore.match(['src/foo.ts']);
      expect(fromDisk).toHaveLength(1);
      // 6 (persisted from match above) + 1 (this match) = 7
      expect(fromDisk[0]!.hitCount).toBe(7);
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

    });

    it('sets originType autonomous and priorityTier normal by default', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Auto gotcha' }],
        1,
      );
      const all = await store.match(['foo.ts']);
      expect(all[0]!.originType).toBe('autonomous');
      expect(all[0]!.priorityTier).toBe('normal');

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

    });

    it('does not match unrelated paths', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'TS files' }],
        1,
      );
      const matches = await store.match(['docs/readme.md']);
      expect(matches).toHaveLength(0);

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

    });

    it('excludes archived gotchas', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Archived' }],
        1,
      );
      const all = await store.match(['foo.ts']);
      expect(all).toHaveLength(1);
      await store.archive(all[0]!.id);
      const afterArchival = await store.match(['foo.ts']);
      expect(afterArchival).toHaveLength(0);
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

    });

    it('increments hitCount on each match per ARCH-AC-KNOWLEDGE spec (#116)', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Gotcha A' }],
        1,
      );
      // hitCount starts at 1 after store
      const firstMatch = await store.match(['src/foo.ts']);
      expect(firstMatch).toHaveLength(1);
      expect(firstMatch[0]!.hitCount).toBe(2); // 1 (store) + 1 (match)

      // Second match increments again
      const secondMatch = await store.match(['src/foo.ts']);
      expect(secondMatch[0]!.hitCount).toBe(3); // 2 + 1 (match)

      // store() dedup also increments
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'gotcha a' }],
        2,
      );
      const afterDedup = await store.match(['src/foo.ts']);
      expect(afterDedup[0]!.hitCount).toBe(5); // 3 + 1 (dedup) + 1 (match)

    });

    it('persists hitCount increments from match to disk (#116)', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Persist test' }],
        1,
      );
      await store.match(['src/foo.ts']); // hitCount: 1→2

      // Re-create store from disk to verify persistence
      const freshStore = new GotchaStore(storePath);
      const result = await freshStore.match(['src/foo.ts']);
      expect(result).toHaveLength(1);
      expect(result[0]!.hitCount).toBe(3); // 2 (from disk) + 1 (this match)
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

    });
  });

  describe('incrementHitCount', () => {
    it('increments hitCount for a known id', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Test' }],
        1,
      );
      const m = await store.match(['foo.ts']); // hitCount: 1→2 (match increments)
      const id = m[0]!.id;
      await store.incrementHitCount(id); // hitCount: 2→3
      const after = await store.match(['foo.ts']); // hitCount: 3→4 (match increments)
      expect(after[0]!.hitCount).toBe(4);

    });

    it('does nothing for unknown id', async () => {
      await store.incrementHitCount('non-existent-id');

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

    });

    it('excludes gotchas below threshold', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Rare' }],
        1,
      );
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(0);

    });

    it('halves threshold for elevated (operator) gotchas — floor(5/2)=2', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Op gotcha' }],
        1,
        'operator',
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      // threshold=5, elevated => effectiveThreshold=floor(5/2)=2; hitCount starts at 1, need 1 more
      await store.incrementHitCount(id);
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(1);

    });

    it('elevated gotcha with hitCount=1 is NOT a promotion candidate at threshold=5', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Single hit elevated' }],
        1,
        'operator',
      );
      // hitCount=1, effectiveThreshold=floor(5/2)=2 → not eligible
      const candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(0);

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

    });
  });

  describe('archive', () => {
    it('archives a gotcha so it is excluded from match and promotion candidates', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Will be archived' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      expect(m).toHaveLength(1);
      const id = m[0]!.id;
      // Bump hitCount to make it a promotion candidate
      for (let i = 0; i < 4; i++) {
        await store.incrementHitCount(id);
      }
      const candidatesBefore = await store.getPromotionCandidates(5);
      expect(candidatesBefore).toHaveLength(1);

      await store.archive(id);

      // Excluded from match
      const afterMatch = await store.match(['foo.ts']);
      expect(afterMatch).toHaveLength(0);
      // Excluded from promotion candidates
      const candidatesAfter = await store.getPromotionCandidates(5);
      expect(candidatesAfter).toHaveLength(0);
    });

    it('does nothing for unknown id', async () => {
      await store.archive('non-existent-id');
      // No error thrown
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
      // hitCount: 1 (store) + 1 (first match) + 3 (incrementHitCount×3) = 5, then +1 (this match) = 6
      const after = await store.match(['foo.ts']);
      expect(after).toHaveLength(1);
      expect(after[0]!.hitCount).toBe(6);

    });

    it('auto-compacts when JSONL bloat exceeds threshold (#135)', async () => {
      // Create 26 unique gotchas (26 raw lines)
      for (let i = 0; i < 26; i++) {
        await store.store(
          [{ artifactPatterns: [`src/${i}/**/*.ts`], description: `Gotcha ${i}` }],
          i,
        );
      }
      // Each match appends 1 hit-increment line. 26 matches → 52+ raw lines with 26 unique = 2x ratio
      for (let i = 0; i < 26; i++) {
        await store.match([`src/${i}/foo.ts`]);
      }

      // compactIfNeeded runs after match when ratio >= 2x and raw >= 50
      // Verify by reading raw JSONL — should have exactly 26 lines (one per unique gotcha)
      const { readFile } = await import('fs/promises');
      const raw = await readFile(storePath, 'utf-8');
      const lines = raw.split('\n').filter((l: string) => l.trim());
      expect(lines.length).toBe(26);

      // Data integrity: re-read from disk, all 26 gotchas accessible
      const freshStore = new GotchaStore(storePath);
      for (let i = 0; i < 26; i++) {
        const result = await freshStore.match([`src/${i}/foo.ts`]);
        expect(result.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('removes archived entries during compaction', async () => {
      await store.store(
        [
          { artifactPatterns: ['**/*.ts'], description: 'Keep' },
          { artifactPatterns: ['**/*.ts'], description: 'Archive me' },
        ],
        1,
      );
      const m = await store.match(['foo.ts']);
      const archiveTarget = m.find((g) => g.description === 'Archive me')!;
      await store.archive(archiveTarget.id);
      await store.compact();

      // After compact, archived entry is physically removed
      // Re-create store to force re-read from disk
      const freshStore = new GotchaStore(storePath);
      const all = await freshStore.match(['foo.ts']);
      expect(all).toHaveLength(1);
      expect(all[0]!.description).toBe('Keep');
    });
  });
});
