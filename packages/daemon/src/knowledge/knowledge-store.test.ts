// src/knowledge/knowledge-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, rename, chmod, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeRecord } from './record-types.js';
import { DEFAULT_POLICIES } from './policy-registry.js';

let dir: string;
let storePath: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'knowledge-store-test-'));
  storePath = join(dir, 'knowledge.jsonl');
  store = new KnowledgeStore(storePath, DEFAULT_POLICIES);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeMarker(overrides: Partial<{ artifactPatterns: string[]; description: string; rootCauseTag: string; reasoning: string }> = {}) {
  return {
    artifactPatterns: overrides.artifactPatterns ?? ['src/**/*.ts'],
    description: overrides.description ?? 'Test pitfall',
    rootCauseTag: overrides.rootCauseTag,
    reasoning: overrides.reasoning,
  };
}

describe('KnowledgeStore', () => {
  describe('storeRecord', () => {
    it('stores a new technical_pitfall as active when origin is autonomous', async () => {
      const count = await store.storeRecord(
        [makeMarker()],
        'issue-42',
        'autonomous',
        'technical_pitfall',
      );
      expect(count).toBe(1);
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(1);
      expect(records[0]!.lifecycleStatus).toBe('active');
      expect(records[0]!.recordType).toBe('technical_pitfall');
      expect(records[0]!.originType).toBe('autonomous');
      expect(records[0]!.priorityTier).toBe('normal');
    });

    it('stores as candidate when origin is retrospective-tech-lead', async () => {
      const count = await store.storeRecord(
        [makeMarker()],
        'retro-1',
        'retrospective-tech-lead',
        'technical_pitfall',
      );
      expect(count).toBe(1);
      // Candidates are NOT available for injection
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(0);
    });

    it('stores as candidate when origin is retrospective-po', async () => {
      await store.storeRecord(
        [makeMarker()],
        'retro-2',
        'retrospective-po',
        'business_observation',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'product_ownership');
      expect(records).toHaveLength(0); // candidate, not active
    });

    it('stores operator corrections as active with elevated priority', async () => {
      await store.storeRecord(
        [makeMarker()],
        'review-1',
        'operator',
        'operator_correction',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(1);
      expect(records[0]!.lifecycleStatus).toBe('active');
      expect(records[0]!.priorityTier).toBe('elevated');
      expect(records[0]!.originType).toBe('operator');
    });

    it('deduplicates by patterns + description similarity', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Always validate user input' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      const count = await store.storeRecord(
        [makeMarker({ description: 'always validate user input' })],
        'issue-2',
        'autonomous',
        'technical_pitfall',
      );
      expect(count).toBe(0); // deduped
    });

    it('elevates existing autonomous record to operator when duplicate is stored with operator origin (#376)', async () => {
      // Step 1: Store an autonomous record
      await store.storeRecord(
        [makeMarker({ description: 'Always validate user input before SQL queries' })],
        'issue-10',
        'autonomous',
        'technical_pitfall',
      );
      const before = await store.loadAll();
      expect(before).toHaveLength(1);
      expect(before[0]!.originType).toBe('autonomous');
      expect(before[0]!.priorityTier).toBe('normal');
      expect(before[0]!.hitCount).toBe(1);

      // Step 2: Store a duplicate with operator origin (simulating operator submitting same finding)
      const count = await store.storeRecord(
        [makeMarker({ description: 'Always validate user input before SQL queries' })],
        'review-5',
        'operator',
        'technical_pitfall',
      );
      expect(count).toBe(0); // deduped, not a new record

      // Step 3: Verify the existing record was elevated
      const after = await store.loadAll();
      expect(after).toHaveLength(1);
      expect(after[0]!.originType).toBe('operator');
      expect(after[0]!.priorityTier).toBe('elevated');
      expect(after[0]!.hitCount).toBe(2); // incremented by dedup
    });

    it('does not re-elevate when duplicate operator record matches an already-operator record (#376)', async () => {
      // Store as operator directly
      await store.storeRecord(
        [makeMarker({ description: 'Operator correction about imports' })],
        'review-1',
        'operator',
        'operator_correction',
      );
      const before = await store.loadAll();
      expect(before[0]!.originType).toBe('operator');
      expect(before[0]!.priorityTier).toBe('elevated');

      // Store a duplicate also with operator origin
      await store.storeRecord(
        [makeMarker({ description: 'Operator correction about imports' })],
        'review-2',
        'operator',
        'operator_correction',
      );
      const after = await store.loadAll();
      expect(after).toHaveLength(1);
      // Should remain operator/elevated (no-op, since it already was)
      expect(after[0]!.originType).toBe('operator');
      expect(after[0]!.priorityTier).toBe('elevated');
      expect(after[0]!.hitCount).toBe(2); // hitCount still increments on dedup
    });

    it('stores rootCauseTag and reasoning when provided', async () => {
      await store.storeRecord(
        [makeMarker({ rootCauseTag: 'race-cond', reasoning: 'Found during cleanup' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records[0]!.rootCauseTag).toBe('race-cond');
      expect(records[0]!.reasoning).toBe('Found during cleanup');
    });
  });

  describe('matchRecords', () => {
    it('matches by glob pattern and filters by session type', async () => {
      await store.storeRecord(
        [makeMarker()],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      // technical_pitfall targets implementation and review
      const implMatches = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(implMatches).toHaveLength(1);

      const reviewMatches = await store.matchRecords(['src/foo.ts'], 'review');
      expect(reviewMatches).toHaveLength(1);

      // product_ownership should NOT receive technical_pitfall
      const poMatches = await store.matchRecords(['src/foo.ts'], 'product_ownership');
      expect(poMatches).toHaveLength(0);
    });

    it('business_observation only targets product_ownership sessions', async () => {
      await store.storeRecord(
        [makeMarker()],
        'issue-1',
        'autonomous',
        'business_observation',
      );
      const poMatches = await store.matchRecords(['src/foo.ts'], 'product_ownership');
      expect(poMatches).toHaveLength(1);

      const implMatches = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(implMatches).toHaveLength(0);
    });

    it('excludes promoted and archived records', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Promoted one' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      await store.storeRecord(
        [makeMarker({ description: 'Archived one' })],
        'issue-2',
        'autonomous',
        'technical_pitfall',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(2);

      await store.transitionStatus(records[0]!.id, 'promoted');
      await store.transitionStatus(records[1]!.id, 'archived');

      const after = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(after).toHaveLength(0);
    });

    it('increments hit count on match', async () => {
      await store.storeRecord(
        [makeMarker()],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      const first = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(first[0]!.hitCount).toBe(2); // 1 (store) + 1 (match)
      const second = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(second[0]!.hitCount).toBe(3);
    });

    it('sorts elevated before normal, then by hitCount descending', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Normal hit' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      await store.storeRecord(
        [makeMarker({ description: 'Operator correction' })],
        'review-1',
        'operator',
        'operator_correction',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records[0]!.priorityTier).toBe('elevated');
      expect(records[1]!.priorityTier).toBe('normal');
    });

    it('sorts business_observation records by recency (newest first)', async () => {
      // Store older record first
      await store.storeRecord(
        [makeMarker({ description: 'Old observation about patterns' })],
        'retro-1',
        'autonomous',
        'business_observation',
      );
      // Advance time slightly for a newer record
      await new Promise(r => setTimeout(r, 10));
      await store.storeRecord(
        [makeMarker({ description: 'New observation about trends' })],
        'retro-2',
        'autonomous',
        'business_observation',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'product_ownership');
      expect(records).toHaveLength(2);
      // Newest should come first (recency sort)
      expect(records[0]!.description).toBe('New observation about trends');
      expect(records[1]!.description).toBe('Old observation about patterns');
    });

    it('sorts review_finding records by severity (hitCount) then recency', async () => {
      // Store a record and bump its hitCount by matching it multiple times
      await store.storeRecord(
        [makeMarker({ description: 'Low-hit finding about security' })],
        'review-1',
        'autonomous',
        'review_finding',
      );
      await store.storeRecord(
        [makeMarker({ description: 'High-hit finding about validation' })],
        'review-2',
        'autonomous',
        'review_finding',
      );
      // Bump hit count on high-hit finding by storing a duplicate
      await store.storeRecord(
        [makeMarker({ description: 'High-hit finding about validation' })],
        'review-3',
        'autonomous',
        'review_finding',
      );

      const records = await store.matchRecords(['src/foo.ts'], 'technical_leadership');
      expect(records).toHaveLength(2);
      // Higher hitCount first (severity_then_recency)
      expect(records[0]!.hitCount).toBeGreaterThan(records[1]!.hitCount);
      expect(records[0]!.description).toBe('High-hit finding about validation');
      expect(records[1]!.description).toBe('Low-hit finding about security');
    });

    it('sorts review_finding records by recency when hitCount is equal', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Older finding about auth' })],
        'review-1',
        'autonomous',
        'review_finding',
      );
      await new Promise(r => setTimeout(r, 10));
      await store.storeRecord(
        [makeMarker({ description: 'Newer finding about input' })],
        'review-2',
        'autonomous',
        'review_finding',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'technical_leadership');
      expect(records).toHaveLength(2);
      // Both records have hitCount=1 at creation; matchRecords increments both equally,
      // so the tie-breaker is recency — newest first
      expect(records[0]!.description).toBe('Newer finding about input');
      expect(records[1]!.description).toBe('Older finding about auth');
    });

    it('accepts explicit recordType filter', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Pitfall' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      await store.storeRecord(
        [makeMarker({ description: 'Correction' })],
        'review-1',
        'operator',
        'operator_correction',
      );
      const filtered = await store.matchRecords(['src/foo.ts'], 'implementation', 'technical_pitfall');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.recordType).toBe('technical_pitfall');
    });
  });

  describe('transitionStatus', () => {
    it('transitions candidate to active (approval)', async () => {
      await store.storeRecord(
        [makeMarker()],
        'retro-1',
        'retrospective-tech-lead',
        'technical_pitfall',
      );
      const all = await store.loadAll();
      const candidate = all.find(r => r.lifecycleStatus === 'candidate')!;
      expect(candidate).toBeDefined();

      await store.transitionStatus(candidate.id, 'active');
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(1);
      expect(records[0]!.lifecycleStatus).toBe('active');
    });

    it('throws when expectedCurrentStatus does not match', async () => {
      await store.storeRecord(
        [makeMarker()],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      const all = await store.loadAll();
      const record = all[0]!;
      expect(record.lifecycleStatus).toBe('active');

      await expect(
        store.transitionStatus(record.id, 'promoted', 'candidate'),
      ).rejects.toThrow(/expected status 'candidate' but found 'active'/);

      // Verify status was NOT changed
      const after = await store.loadAll();
      expect(after.find(r => r.id === record.id)!.lifecycleStatus).toBe('active');
    });

    it('succeeds when expectedCurrentStatus matches', async () => {
      await store.storeRecord(
        [makeMarker()],
        'retro-1',
        'retrospective-tech-lead',
        'technical_pitfall',
      );
      const all = await store.loadAll();
      const candidate = all.find(r => r.lifecycleStatus === 'candidate')!;

      await store.transitionStatus(candidate.id, 'active', 'candidate');
      const after = await store.loadAll();
      expect(after.find(r => r.id === candidate.id)!.lifecycleStatus).toBe('active');
    });

    it('prevents approving an already-archived record', async () => {
      await store.storeRecord(
        [makeMarker()],
        'retro-1',
        'retrospective-tech-lead',
        'technical_pitfall',
      );
      const all = await store.loadAll();
      const candidate = all.find(r => r.lifecycleStatus === 'candidate')!;

      // Archive it first (simulates auto-archival winning the race)
      await store.transitionStatus(candidate.id, 'archived');

      // Now try to approve — should fail because it's archived, not candidate
      await expect(
        store.transitionStatus(candidate.id, 'active', 'candidate'),
      ).rejects.toThrow(/expected status 'candidate' but found 'archived'/);
    });

    it('transitions active to archived (rejection)', async () => {
      await store.storeRecord(
        [makeMarker()],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      await store.transitionStatus(records[0]!.id, 'archived');
      const after = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(after).toHaveLength(0);
    });
  });

  describe('queryByRootCause', () => {
    it('returns all records with a given rootCauseTag regardless of status', async () => {
      await store.storeRecord(
        [makeMarker({ rootCauseTag: 'leak', description: 'Active leak' })],
        'issue-1',
        'autonomous',
        'technical_pitfall',
      );
      await store.storeRecord(
        [makeMarker({ rootCauseTag: 'leak', description: 'Archived leak' })],
        'issue-2',
        'autonomous',
        'technical_pitfall',
      );
      // Archive the second one
      const all = await store.loadAll();
      const second = all.find(r => r.description === 'Archived leak')!;
      await store.transitionStatus(second.id, 'archived');

      const results = await store.queryByRootCause('leak');
      expect(results).toHaveLength(2);
    });

    it('returns empty when no records match the tag', async () => {
      const results = await store.queryByRootCause('nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('scanForArchival', () => {
    it('archives old records with low hit counts', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Old low-hit' })],
        'issue-1', 'autonomous', 'technical_pitfall',
      );
      // Use policies with archivalMaxAgeDays = 90 (default), so maxAge=-1 trick won't work here
      // Instead create a store with custom policies that have archivalMaxAgeDays = 0
      const shortPolicies = { ...DEFAULT_POLICIES };
      shortPolicies.technical_pitfall = {
        ...shortPolicies.technical_pitfall,
        archivalMaxAgeDays: -1, // any age triggers archival
        archivalMinHitCount: 100, // effectively all records are "low hit"
      };
      const shortStore = new KnowledgeStore(join(dir, 'archival.jsonl'), shortPolicies);
      await shortStore.storeRecord(
        [makeMarker({ description: 'Will be archived' })],
        'issue-1', 'autonomous', 'technical_pitfall',
      );
      const archived = await shortStore.scanForArchival();
      expect(archived).toHaveLength(1);
      const records = await shortStore.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(0);
    });

    it('does not archive technical_pitfall records with operator originType (#363)', async () => {
      // Create a store with aggressive archival to trigger the bug
      const shortPolicies = { ...DEFAULT_POLICIES };
      shortPolicies.technical_pitfall = {
        ...shortPolicies.technical_pitfall,
        archivalMaxAgeDays: -1, // any age triggers archival
        archivalMinHitCount: 100, // effectively all records are "low hit"
      };
      const shortStore = new KnowledgeStore(join(dir, 'archival-operator.jsonl'), shortPolicies);
      // Store as operator origin — simulates dedup upgrade path
      await shortStore.storeRecord(
        [makeMarker({ description: 'Operator-elevated pitfall' })],
        'issue-1', 'operator', 'technical_pitfall',
      );
      const archived = await shortStore.scanForArchival();
      // Operator-origin records must be exempt from archival regardless of recordType
      expect(archived).toHaveLength(0);
      const records = await shortStore.loadAll();
      expect(records[0]?.lifecycleStatus).toBe('active');
    });

    it('does not archive operator_correction records (Infinity archivalMaxAge)', async () => {
      await store.storeRecord(
        [makeMarker({ description: 'Op correction' })],
        'review-1', 'operator', 'operator_correction',
      );
      const archived = await store.scanForArchival();
      expect(archived).not.toContain(
        (await store.loadAll()).find(r => r.description === 'Op correction')?.id,
      );
      const records = await store.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(1);
    });
  });

  describe('v1 migration', () => {
    it('migrates gotchas.jsonl to knowledge.jsonl on first read', async () => {
      const gotchaPath = join(dir, 'gotchas.jsonl');
      const v1Entry = {
        id: 'old-1',
        artifactPatterns: ['src/**/*.ts'],
        description: 'V1 gotcha',
        sourceIssue: 10,
        confidence: 1,
        createdAt: '2026-01-01T00:00:00Z',
        hitCount: 3,
        promoted: false,
        archived: false,
        originType: 'autonomous',
        priorityTier: 'normal',
      };
      await writeFile(gotchaPath, JSON.stringify(v1Entry) + '\n');

      // Create store pointing to knowledge.jsonl that doesn't exist yet
      const migratingStore = new KnowledgeStore(storePath, DEFAULT_POLICIES, gotchaPath);
      const records = await migratingStore.matchRecords(['src/foo.ts'], 'implementation');
      expect(records).toHaveLength(1);
      expect(records[0]!.recordType).toBe('technical_pitfall');
      expect(records[0]!.lifecycleStatus).toBe('active');
      expect(records[0]!.sourceId).toBe('issue-10');

      // Old file renamed
      const migratedExists = await readFile(gotchaPath + '.migrated', 'utf-8').then(() => true).catch(() => false);
      expect(migratedExists).toBe(true);
    });

    it('re-throws non-ENOENT errors and resets migrated flag for retry (#377)', async () => {
      // Create a directory where the knowledge.jsonl path would be —
      // access() on a path inside an unreadable dir throws EACCES, not ENOENT
      const restrictedDir = join(dir, 'restricted');
      await mkdir(restrictedDir);
      const restrictedStorePath = join(restrictedDir, 'knowledge.jsonl');

      const gotchaPath = join(dir, 'gotchas.jsonl');
      const v1Entry = {
        id: 'old-1',
        artifactPatterns: ['src/**/*.ts'],
        description: 'V1 gotcha',
        sourceIssue: 10,
        confidence: 1,
        createdAt: '2026-01-01T00:00:00Z',
        hitCount: 3,
        promoted: false,
        archived: false,
        originType: 'autonomous',
        priorityTier: 'normal',
      };
      await writeFile(gotchaPath, JSON.stringify(v1Entry) + '\n');

      const migratingStore = new KnowledgeStore(restrictedStorePath, DEFAULT_POLICIES, gotchaPath);

      // Remove all permissions on the directory so access() throws EACCES
      await chmod(restrictedDir, 0o000);

      try {
        // First call should throw — EACCES, not ENOENT
        await expect(migratingStore.loadAll()).rejects.toThrow(/EACCES/);
      } finally {
        // Restore permissions so cleanup works
        await chmod(restrictedDir, 0o755);
      }

      // Verify retry works — migrated flag was reset so migration is re-attempted
      const records = await migratingStore.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0]!.recordType).toBe('technical_pitfall');
    });
  });

  describe('compact', () => {
    it('removes duplicate log entries keeping last version', async () => {
      await store.storeRecord([makeMarker()], 'issue-1', 'autonomous', 'technical_pitfall');
      // Multiple matches create multiple JSONL lines for same record
      await store.matchRecords(['src/foo.ts'], 'implementation');
      await store.matchRecords(['src/foo.ts'], 'implementation');
      await store.matchRecords(['src/foo.ts'], 'implementation');

      await store.compact();

      const raw = await readFile(storePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      expect(lines).toHaveLength(1); // only one unique record
    });
  });
});
