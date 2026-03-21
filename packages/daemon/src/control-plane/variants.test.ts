import { describe, it, expect } from 'vitest';
import { selectVariant } from './variants.js';
import type { WorkRequest } from '../types.js';

function makeRequest(labels: string[]): WorkRequest {
  return { issueNumber: 1, title: 'Test', body: '', labels, specRefs: [] };
}

describe('selectVariant', () => {
  it('returns website for website-init label', () => {
    expect(selectVariant(makeRequest(['ready', 'website-init']))).toBe('website');
  });

  it('returns website even without ready label', () => {
    expect(selectVariant(makeRequest(['website-init']))).toBe('website');
  });

  it('returns bug for bug label', () => {
    expect(selectVariant(makeRequest(['bug']))).toBe('bug');
  });

  it('returns bug when bug label combined with ready', () => {
    expect(selectVariant(makeRequest(['ready', 'bug']))).toBe('bug');
  });

  it('returns feature-simple when no special labels', () => {
    expect(selectVariant(makeRequest(['ready']))).toBe('feature-simple');
  });

  it('returns feature-simple for empty labels', () => {
    expect(selectVariant(makeRequest([]))).toBe('feature-simple');
  });

  it('website-init takes priority over bug label', () => {
    expect(selectVariant(makeRequest(['ready', 'website-init', 'bug']))).toBe('website');
  });
});
