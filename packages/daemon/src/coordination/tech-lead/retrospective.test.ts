// src/coordination/tech-lead/retrospective.test.ts
import { describe, it, expect, vi } from 'vitest';
import { submitRetrospectivePitfalls, type KnowledgeStoreDep } from './retrospective.js';
import type { TechLeadRetrospectiveOutput } from './schemas.js';

function makeKnowledge(overrides: Partial<KnowledgeStoreDep> = {}): KnowledgeStoreDep {
  return {
    storeRecord: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe('submitRetrospectivePitfalls', () => {
  it('submits pitfalls to knowledge store', async () => {
    const knowledge = makeKnowledge();
    const output: TechLeadRetrospectiveOutput = {
      pitfalls: [
        {
          artifactPatterns: ['src/validation/'],
          description: 'Missing error handling in gate checks',
          severity: 7,
          rootCauseTag: 'error-handling',
        },
        {
          artifactPatterns: ['src/lib/'],
          description: 'Inconsistent null checks',
          severity: 5,
          rootCauseTag: 'null-safety',
        },
      ],
      observations: [],
    };

    const count = await submitRetrospectivePitfalls(output, knowledge, 'session-123');

    expect(knowledge.storeRecord).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          artifactPatterns: ['src/validation/'],
          description: 'Missing error handling in gate checks',
          rootCauseTag: 'error-handling',
        }),
      ]),
      'session-123',
      'retrospective-tech-lead',
      'technical_pitfall',
    );
    expect(count).toBe(1);
  });

  it('returns 0 for empty pitfalls', async () => {
    const knowledge = makeKnowledge();
    const output: TechLeadRetrospectiveOutput = {
      pitfalls: [],
      observations: ['Coverage improved'],
    };

    const count = await submitRetrospectivePitfalls(output, knowledge, 'session-123');

    expect(count).toBe(0);
    expect(knowledge.storeRecord).not.toHaveBeenCalled();
  });
});
