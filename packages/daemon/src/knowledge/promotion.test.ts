// src/knowledge/promotion.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getPromotionCandidates } from './promotion.js';
import type { GotchaStore } from './gotcha-store.js';
import type { Gotcha } from '../types.js';

function makeGotcha(overrides: Partial<Gotcha> = {}): Gotcha {
  return {
    id: 'test-id',
    artifactPatterns: ['src/**/*.ts'],
    description: 'A test gotcha',
    sourceIssue: 42,
    confidence: 1,
    createdAt: new Date().toISOString(),
    hitCount: 5,
    promoted: false,
    archived: false,
    originType: 'autonomous',
    priorityTier: 'normal',
    ...overrides,
  };
}

function makeMockStore(gotchas: Gotcha[]): GotchaStore {
  return {
    getPromotionCandidates: vi.fn().mockResolvedValue(gotchas),
  } as unknown as GotchaStore;
}

describe('getPromotionCandidates', () => {
  it('returns empty array when store has no candidates', async () => {
    const store = makeMockStore([]);
    const result = await getPromotionCandidates(store);
    expect(result).toHaveLength(0);
  });

  it('returns candidates with formatted suggestedDocContent', async () => {
    const gotcha = makeGotcha({
      id: 'abc',
      description: 'Avoid mutating state',
      artifactPatterns: ['src/**/*.ts', 'src/**/*.tsx'],
      sourceIssue: 99,
      hitCount: 7,
    });
    const store = makeMockStore([gotcha]);
    const result = await getPromotionCandidates(store);

    expect(result).toHaveLength(1);
    expect(result[0]!.gotcha).toEqual(gotcha);
    expect(result[0]!.suggestedDocContent).toContain('## Avoid mutating state');
    expect(result[0]!.suggestedDocContent).toContain('src/**/*.ts, src/**/*.tsx');
    expect(result[0]!.suggestedDocContent).toContain('Issue #99');
    expect(result[0]!.suggestedDocContent).toContain('Hits: 7');
  });

  it('passes threshold to store.getPromotionCandidates', async () => {
    const store = makeMockStore([]);
    await getPromotionCandidates(store, 10);
    expect(store.getPromotionCandidates).toHaveBeenCalledWith(10);
  });

  it('passes undefined threshold when not specified', async () => {
    const store = makeMockStore([]);
    await getPromotionCandidates(store);
    expect(store.getPromotionCandidates).toHaveBeenCalledWith(undefined);
  });

  it('handles multiple candidates', async () => {
    const gotchas = [
      makeGotcha({ id: 'g1', description: 'First', sourceIssue: 1, hitCount: 5 }),
      makeGotcha({ id: 'g2', description: 'Second', sourceIssue: 2, hitCount: 8 }),
    ];
    const store = makeMockStore(gotchas);
    const result = await getPromotionCandidates(store);

    expect(result).toHaveLength(2);
    expect(result[0]!.suggestedDocContent).toContain('## First');
    expect(result[1]!.suggestedDocContent).toContain('## Second');
  });
});
