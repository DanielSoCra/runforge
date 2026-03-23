// src/knowledge/prospective-check.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore } from './knowledge-store.js';
import { DEFAULT_POLICIES } from './policy-registry.js';
import { queryProspectiveRisks } from './prospective-check.js';

let dir: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prospective-test-'));
  store = new KnowledgeStore(join(dir, 'knowledge.jsonl'), DEFAULT_POLICIES);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('queryProspectiveRisks', () => {
  it('returns elevated-priority records matching paths', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Operator risk' }],
      'review-1', 'operator', 'operator_correction',
    );
    const risks = await queryProspectiveRisks(store, ['src/foo.ts'], 5);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.priorityTier).toBe('elevated');
  });

  it('returns records with hitCount above severity threshold', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Frequent issue' }],
      'issue-1', 'autonomous', 'technical_pitfall',
    );
    // Bump hits by matching (which increments hitCount)
    for (let i = 0; i < 5; i++) {
      await store.matchRecords(['src/foo.ts'], 'implementation');
    }
    const risks = await queryProspectiveRisks(store, ['src/foo.ts'], 5);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.hitCount).toBeGreaterThanOrEqual(5);
  });

  it('does NOT increment hit counts (read-only)', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Read-only check' }],
      'review-1', 'operator', 'operator_correction',
    );
    const before = (await store.loadAll())[0]!.hitCount;
    await queryProspectiveRisks(store, ['src/foo.ts'], 5);
    const after = (await store.loadAll())[0]!.hitCount;
    expect(after).toBe(before);
  });

  it('excludes non-active records', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Archived risk' }],
      'review-1', 'operator', 'operator_correction',
    );
    const all = await store.loadAll();
    await store.transitionStatus(all[0]!.id, 'archived');
    const risks = await queryProspectiveRisks(store, ['src/foo.ts'], 5);
    expect(risks).toHaveLength(0);
  });

  it('excludes records not matching paths', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/auth/**'], description: 'Auth risk' }],
      'review-1', 'operator', 'operator_correction',
    );
    const risks = await queryProspectiveRisks(store, ['src/dashboard/foo.ts'], 5);
    expect(risks).toHaveLength(0);
  });
});
