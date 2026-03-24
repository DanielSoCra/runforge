// src/coordination/tech-lead/session-output-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseTechLeadOutput, parseRetrospectiveOutput } from './session-output-parser.js';

function makeValidProposal() {
  return {
    id: crypto.randomUUID(),
    proposalType: 'debt_reduction',
    title: 'Reduce debt',
    evidence: [{ signal: 'findings', detail: '10 issues' }],
    affectedAreas: ['src/'],
    riskAssessment: 'Low',
    effortEstimate: '2 days',
    status: 'generated',
    poDecision: null,
    operatorDecision: null,
    priorRejectionId: null,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe('parseTechLeadOutput', () => {
  it('parses valid output with proposals', () => {
    const raw = JSON.stringify({
      proposals: [makeValidProposal()],
      protocolTriggers: ['escalation'],
    });
    const result = parseTechLeadOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.proposals).toHaveLength(1);
      expect(result.data.protocolTriggers).toEqual(['escalation']);
    }
  });

  it('parses empty output with defaults', () => {
    const result = parseTechLeadOutput('{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.proposals).toEqual([]);
      expect(result.data.protocolTriggers).toEqual([]);
    }
  });

  it('returns error for malformed JSON', () => {
    const result = parseTechLeadOutput('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('JSON parse failed');
    }
  });

  it('returns error for invalid schema', () => {
    const result = parseTechLeadOutput(JSON.stringify({
      proposals: [{ invalid: true }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Schema validation failed');
    }
  });
});

describe('parseRetrospectiveOutput', () => {
  it('parses valid retrospective with pitfalls', () => {
    const raw = JSON.stringify({
      pitfalls: [{
        artifactPatterns: ['src/validation/'],
        description: 'Missing error handling',
        severity: 7,
        rootCauseTag: 'error-handling',
      }],
      observations: ['Coverage improved'],
    });
    const result = parseRetrospectiveOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pitfalls).toHaveLength(1);
    }
  });

  it('parses empty retrospective', () => {
    const result = parseRetrospectiveOutput('{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pitfalls).toEqual([]);
    }
  });
});
