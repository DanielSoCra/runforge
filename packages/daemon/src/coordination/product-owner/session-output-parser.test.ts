// src/coordination/product-owner/session-output-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePOAnalysisOutput, parsePOProtocolOutput } from './session-output-parser.js';

describe('parsePOAnalysisOutput', () => {
  it('parses valid output with proposals', () => {
    const raw = JSON.stringify({
      proposals: [{
        title: 'Advance spec',
        rationale: 'Gap found',
        proposalType: 'spec_advancement',
        relatedRefs: ['FUNC-AC-LEARNING'],
        estimatedScope: 'medium',
      }],
      protocolTriggers: ['backlog_grooming'],
    });
    const result = parsePOAnalysisOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.proposals).toHaveLength(1);
      expect(result.data.protocolTriggers).toEqual(['backlog_grooming']);
    }
  });

  it('parses empty output with defaults', () => {
    const result = parsePOAnalysisOutput('{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.proposals).toEqual([]);
      expect(result.data.protocolTriggers).toEqual([]);
    }
  });

  it('returns error for malformed JSON', () => {
    const result = parsePOAnalysisOutput('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('JSON parse failed');
    }
  });

  it('returns error for invalid schema', () => {
    const result = parsePOAnalysisOutput(JSON.stringify({
      proposals: [{ invalid: true }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Schema validation failed');
    }
  });
});

describe('parsePOProtocolOutput', () => {
  it('parses enrichment review output', () => {
    const raw = JSON.stringify({
      decision: 'forward',
      reason: 'High priority',
    });
    const result = parsePOProtocolOutput(raw, 'enrichment_review');
    expect(result.ok).toBe(true);
  });

  it('parses batch planning output', () => {
    const raw = JSON.stringify({
      prioritizedItems: [{ ref: '#42', priority: 1, rationale: 'Blocks others' }],
    });
    const result = parsePOProtocolOutput(raw, 'batch_planning');
    expect(result.ok).toBe(true);
  });

  it('parses retrospective output', () => {
    const raw = JSON.stringify({
      expectationsVsActuals: [{ item: '#42', expected: 'Done', actual: 'Delayed' }],
      businessLessons: [{ description: 'Lesson', artifactRefs: [] }],
    });
    const result = parsePOProtocolOutput(raw, 'retrospective');
    expect(result.ok).toBe(true);
  });

  it('returns error for unknown protocol type', () => {
    const result = parsePOProtocolOutput('{}', 'unknown_protocol');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown protocol type');
    }
  });
});
