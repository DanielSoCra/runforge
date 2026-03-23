// src/knowledge/gotcha-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { GotchaStore, tokenize, jaccardSimilarity } from './gotcha-store.js';

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

    it('upgrades originType and priorityTier when operator correction deduplicates against autonomous gotcha (#280)', async () => {
      // Store an autonomous gotcha first
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Validate input carefully' }],
        1,
        'autonomous',
      );
      const before = await store.match(['foo.ts']);
      expect(before[0]!.originType).toBe('autonomous');
      expect(before[0]!.priorityTier).toBe('normal');

      // Store an operator correction that deduplicates against the autonomous one
      const count = await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'validate input carefully' }],
        2,
        'operator',
      );
      expect(count).toBe(0); // deduped, not new

      // Verify the existing gotcha was upgraded to operator/elevated
      const after = await store.match(['foo.ts']);
      expect(after).toHaveLength(1);
      expect(after[0]!.originType).toBe('operator');
      expect(after[0]!.priorityTier).toBe('elevated');
    });

    it('does not downgrade operator gotcha when autonomous dedup occurs (#280)', async () => {
      // Store an operator gotcha first
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Check permissions' }],
        1,
        'operator',
      );
      // Store an autonomous duplicate
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'check permissions' }],
        2,
        'autonomous',
      );
      const after = await store.match(['foo.ts']);
      expect(after).toHaveLength(1);
      expect(after[0]!.originType).toBe('operator');
      expect(after[0]!.priorityTier).toBe('elevated');
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

    it('serializes with mutex during concurrent file access (#298)', async () => {
      // Seed a gotcha that qualifies for promotion
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Concurrent promo test' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      for (let i = 0; i < 4; i++) {
        await store.incrementHitCount(id);
      }

      // Fire concurrent getPromotionCandidates + store operations.
      // Before the fix, getPromotionCandidates read outside the mutex,
      // so a concurrent appendJsonl could produce a partial line that
      // readJsonl silently drops — causing the candidate to vanish.
      const [candidates1, , candidates2] = await Promise.all([
        store.getPromotionCandidates(5),
        store.store(
          [{ artifactPatterns: ['**/*.js'], description: 'Concurrent new entry' }],
          99,
        ),
        store.getPromotionCandidates(5),
      ]);

      // Both calls must see the promotion candidate — no silent data loss
      expect(candidates1).toHaveLength(1);
      expect(candidates2).toHaveLength(1);

      // Verify the new entry also survived
      const freshStore = new GotchaStore(storePath);
      const newEntry = await freshStore.match(['foo.js']);
      expect(newEntry.length).toBeGreaterThanOrEqual(1);
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

    it('concurrent store+compact do not lose entries appended between loadAll and writeTextSafe (#295)', async () => {
      // Seed 26 unique gotchas to reach compaction threshold
      for (let i = 0; i < 26; i++) {
        await store.store(
          [{ artifactPatterns: [`compact-race/${i}/**`], description: `Compact race ${i}` }],
          i,
        );
      }
      // Generate enough JSONL bloat to trigger compaction (need 50+ lines, 2x ratio)
      for (let i = 0; i < 26; i++) {
        await store.incrementHitCount(
          (await store.match([`compact-race/${i}/foo.ts`]))[0]!.id,
        );
      }

      // Fire concurrent operations — some will trigger compactIfNeeded internally.
      // Before the fix, a store() appending between compact's loadAll() and
      // writeTextSafe() would have its entry permanently lost.
      const concurrentOps = [
        store.store(
          [{ artifactPatterns: ['compact-race/new-a/**'], description: 'New entry A during compact' }],
          100,
        ),
        store.store(
          [{ artifactPatterns: ['compact-race/new-b/**'], description: 'New entry B during compact' }],
          101,
        ),
        store.match(['compact-race/0/foo.ts']),
        store.match(['compact-race/1/foo.ts']),
        store.store(
          [{ artifactPatterns: ['compact-race/new-c/**'], description: 'New entry C during compact' }],
          102,
        ),
      ];
      await Promise.all(concurrentOps);

      // Verify all new entries survive — read from fresh store to confirm disk state
      const freshStore = new GotchaStore(storePath);
      const newA = await freshStore.match(['compact-race/new-a/foo.ts']);
      const newB = await freshStore.match(['compact-race/new-b/foo.ts']);
      const newC = await freshStore.match(['compact-race/new-c/foo.ts']);
      expect(newA.length, 'entry A lost during concurrent compact').toBeGreaterThanOrEqual(1);
      expect(newB.length, 'entry B lost during concurrent compact').toBeGreaterThanOrEqual(1);
      expect(newC.length, 'entry C lost during concurrent compact').toBeGreaterThanOrEqual(1);

      // Verify original entries also survive
      for (let i = 0; i < 26; i++) {
        const fromDisk = await freshStore.match([`compact-race/${i}/foo.ts`]);
        expect(fromDisk.length, `original entry compact-race/${i} lost`).toBeGreaterThanOrEqual(1);
      }
    });

    it('concurrent compactIfNeeded calls do not lose appended entries (#157)', async () => {
      // Seed 26 unique gotchas so compaction threshold (50 raw lines, 2x ratio) is reachable
      for (let i = 0; i < 26; i++) {
        await store.store(
          [{ artifactPatterns: [`race/${i}/**`], description: `Race ${i}` }],
          i,
        );
      }

      // Fire concurrent matches — each appends a hit-increment line AND calls compactIfNeeded.
      // Before the fix, two concurrent compactIfNeeded calls could both read the file
      // before either set the compacting flag, causing the second write to overwrite the first.
      const concurrentMatches = Array.from({ length: 26 }, (_, i) =>
        store.match([`race/${i}/foo.ts`]),
      );
      const results = await Promise.all(concurrentMatches);

      // Every match must return at least one result — none should be lost
      for (let i = 0; i < 26; i++) {
        expect(results[i]!.length).toBeGreaterThanOrEqual(1);
      }

      // Verify data integrity from disk — all 26 gotchas must be readable
      const freshStore = new GotchaStore(storePath);
      for (let i = 0; i < 26; i++) {
        const fromDisk = await freshStore.match([`race/${i}/foo.ts`]);
        expect(fromDisk.length, `gotcha race/${i} lost after concurrent compaction`).toBeGreaterThanOrEqual(1);
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

  describe('Jaccard dedup', () => {
    it('deduplicates descriptions with >0.7 Jaccard similarity', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Always validate user input before processing' }],
        1,
      );
      // Similar but not identical description
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Always validate user input before handling' }],
        2,
      );
      expect(count).toBe(0); // deduped
    });

    it('does NOT deduplicate descriptions with <=0.7 Jaccard similarity', async () => {
      await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Always validate user input before processing' }],
        1,
      );
      const count = await store.store(
        [{ artifactPatterns: ['src/**/*.ts'], description: 'Never forget to close file handles after reading' }],
        2,
      );
      expect(count).toBe(1); // distinct
    });
  });

  describe('rejectPromotion', () => {
    it('sets reviewedAt and excludes from promotion candidates during cooldown', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Rejected gotcha' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      // Bump hits to make it a candidate
      for (let i = 0; i < 4; i++) await store.incrementHitCount(id);
      // Verify it's a candidate first
      let candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(1);

      await store.rejectPromotion(id);

      // Now excluded during cooldown (default 30 days)
      candidates = await store.getPromotionCandidates(5);
      expect(candidates).toHaveLength(0);
    });
  });

  describe('scanForArchival', () => {
    it('archives old gotchas with low hit counts', async () => {
      // Create a gotcha with old createdAt
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Old and unused' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;

      // scanForArchival with maxAgeDays=-1 so any positive age triggers archival
      const archived = await store.scanForArchival(-1, 100);
      expect(archived).toContain(id);

      // Verify excluded from match
      const afterMatch = await store.match(['foo.ts']);
      expect(afterMatch).toHaveLength(0);
    });

    it('does not archive operator corrections regardless of age or hit count (#313)', async () => {
      // Operator corrections are exempt from automatic archival per ARCH-AC-KNOWLEDGE §archival-flow
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Operator correction never archived' }],
        1,
        'operator',
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;

      // maxAgeDays=0 treats everything as old, minHitCount=100 means low hits
      const archived = await store.scanForArchival(0, 100);
      expect(archived).not.toContain(id);

      // Verify still matchable
      const afterMatch = await store.match(['foo.ts']);
      expect(afterMatch).toHaveLength(1);
      expect(afterMatch[0]!.originType).toBe('operator');
    });

    it('does not archive gotchas with sufficient hits', async () => {
      await store.store(
        [{ artifactPatterns: ['**/*.ts'], description: 'Frequently hit' }],
        1,
      );
      const m = await store.match(['foo.ts']);
      const id = m[0]!.id;
      for (let i = 0; i < 5; i++) await store.incrementHitCount(id);

      const archived = await store.scanForArchival(0, 5);
      expect(archived).not.toContain(id);
    });
  });
});

describe('tokenize', () => {
  it('lowercases and removes stopwords', () => {
    const tokens = tokenize('The quick Brown fox is Very fast');
    expect(tokens.has('quick')).toBe(true);
    expect(tokens.has('brown')).toBe(true);
    expect(tokens.has('fox')).toBe(true);
    expect(tokens.has('fast')).toBe(true);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('is')).toBe(false);
    expect(tokens.has('very')).toBe(false);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns correct value for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4 → 0.5
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });
});
