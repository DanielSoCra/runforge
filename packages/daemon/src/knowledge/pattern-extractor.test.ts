// src/knowledge/pattern-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractPatterns } from './pattern-extractor.js';
import type { Gotcha } from '../types.js';

function makeGotcha(overrides: Partial<Gotcha>): Gotcha {
  return {
    id: 'test',
    artifactPatterns: ['src/**/*.ts'],
    description: 'test',
    sourceIssue: 1,
    confidence: 1,
    createdAt: new Date().toISOString(),
    hitCount: 1,
    promoted: false,
    archived: false,
    originType: 'autonomous',
    priorityTier: 'normal',
    ...overrides,
  };
}

describe('extractPatterns', () => {
  it('returns empty array when fewer than 3 gotchas', () => {
    const gotchas = [
      makeGotcha({ id: 'g1', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input data carefully' }),
      makeGotcha({ id: 'g2', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input parameters carefully' }),
    ];
    const patterns = extractPatterns(gotchas);
    expect(patterns).toHaveLength(0);
  });

  it('groups 3+ gotchas with overlapping patterns and similar descriptions', () => {
    const gotchas = [
      makeGotcha({ id: 'g1', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input data before processing requests' }),
      makeGotcha({ id: 'g2', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input parameters before processing calls' }),
      makeGotcha({ id: 'g3', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input fields before processing handlers' }),
    ];
    const patterns = extractPatterns(gotchas);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0]!.key).toBeDefined();
    expect(patterns[0]!.description).toBeDefined();
    expect(patterns[0]!.confidence).toBeGreaterThan(0);
  });

  it('does NOT group gotchas with non-overlapping artifact patterns', () => {
    const gotchas = [
      makeGotcha({ id: 'g1', artifactPatterns: ['src/**/*.ts'], description: 'Always validate input data before processing' }),
      makeGotcha({ id: 'g2', artifactPatterns: ['docs/**/*.md'], description: 'Always validate input data before processing' }),
      makeGotcha({ id: 'g3', artifactPatterns: ['test/**/*.ts'], description: 'Always validate input data before processing' }),
    ];
    const patterns = extractPatterns(gotchas);
    expect(patterns).toHaveLength(0);
  });

  it('assigns higher confidence to larger groups', () => {
    const base = 'Always validate input data before processing';
    const gotchas = [
      makeGotcha({ id: 'g1', artifactPatterns: ['src/**/*.ts'], description: `${base} requests` }),
      makeGotcha({ id: 'g2', artifactPatterns: ['src/**/*.ts'], description: `${base} calls` }),
      makeGotcha({ id: 'g3', artifactPatterns: ['src/**/*.ts'], description: `${base} handlers` }),
      makeGotcha({ id: 'g4', artifactPatterns: ['src/**/*.ts'], description: `${base} services` }),
      makeGotcha({ id: 'g5', artifactPatterns: ['src/**/*.ts'], description: `${base} functions` }),
    ];
    const patterns = extractPatterns(gotchas);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    // 5-member group should have higher confidence than minimum 3
    expect(patterns[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns empty array for empty input', () => {
    expect(extractPatterns([])).toHaveLength(0);
  });
});
