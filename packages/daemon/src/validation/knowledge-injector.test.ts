// src/validation/knowledge-injector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { injectKnowledge } from './knowledge-injector.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import type { KnowledgeRecord } from '../knowledge/record-types.js';

function makeRecord(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: 'rec-1',
    recordType: 'technical_pitfall',
    artifactPatterns: ['src/foo.ts'],
    description: 'Watch out for null checks',
    sourceId: 'issue-1',
    confidence: 1,
    createdAt: new Date().toISOString(),
    hitCount: 3,
    lifecycleStatus: 'active',
    originType: 'autonomous',
    priorityTier: 'normal',
    ...overrides,
  };
}

function makeStore(records: KnowledgeRecord[]): KnowledgeStore {
  return {
    matchRecords: vi.fn().mockResolvedValue(records),
  } as unknown as KnowledgeStore;
}

describe('injectKnowledge', () => {
  it('returns empty string when no records match', async () => {
    const store = makeStore([]);
    const result = await injectKnowledge(['src/foo.ts'], store);
    expect(result).toBe('');
    expect(store.matchRecords).toHaveBeenCalledWith(['src/foo.ts'], 'review');
  });

  it('formats matched records as Known Issues markdown section', async () => {
    const records = [
      makeRecord({ description: 'Null pointer risk in parser' }),
      makeRecord({ id: 'rec-2', description: 'Race condition on cache invalidation' }),
    ];
    const store = makeStore(records);
    const result = await injectKnowledge(['src/parser.ts'], store);

    expect(result).toContain('## Known Issues');
    expect(result).toContain('- Null pointer risk in parser');
    expect(result).toContain('- Race condition on cache invalidation');
  });

  it('calls matchRecords with session type "review"', async () => {
    const store = makeStore([]);
    await injectKnowledge(['src/a.ts', 'src/b.ts'], store);
    expect(store.matchRecords).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'], 'review');
  });

  it('does not call matchRecords when artifact paths are empty', async () => {
    const store = makeStore([]);
    const result = await injectKnowledge([], store);
    expect(result).toBe('');
    expect(store.matchRecords).not.toHaveBeenCalled();
  });
});
