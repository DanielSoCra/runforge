// src/coordination/tech-lead/schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  TechnicalProposalSchema,
  TechnicalEnrichmentSchema,
  SignalDigestSchema,
  ProtocolExchangeSchema,
  TechLeadOutputSchema,
  TechLeadRetrospectiveOutputSchema,
  MetricDataPointSchema,
  TechProposalStatusSchema,
  ProposalTypeSchema,
} from './schemas.js';

function makeProposalData(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    proposalType: 'debt_reduction',
    title: 'Reduce tech debt in validation module',
    evidence: [{ signal: 'review_findings', detail: '12 unresolved findings' }],
    affectedAreas: ['packages/daemon/src/validation/'],
    riskAssessment: 'Low risk — isolated module',
    effortEstimate: '2 days',
    status: 'generated',
    poDecision: null,
    operatorDecision: null,
    priorRejectionId: null,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TechnicalProposalSchema', () => {
  it('parses valid proposal', () => {
    const result = TechnicalProposalSchema.safeParse(makeProposalData());
    expect(result.success).toBe(true);
  });

  it('accepts unassessed effort estimate', () => {
    const result = TechnicalProposalSchema.safeParse(
      makeProposalData({ effortEstimate: 'unassessed' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.effortEstimate).toBe('unassessed');
    }
  });

  it('rejects invalid proposal type', () => {
    const result = TechnicalProposalSchema.safeParse(
      makeProposalData({ proposalType: 'feature_request' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects invalid status', () => {
    const result = TechnicalProposalSchema.safeParse(
      makeProposalData({ status: 'unknown_status' }),
    );
    expect(result.success).toBe(false);
  });

  it('defaults nullable fields to null', () => {
    const data = makeProposalData();
    delete (data as Record<string, unknown>).poDecision;
    delete (data as Record<string, unknown>).operatorDecision;
    delete (data as Record<string, unknown>).priorRejectionId;
    const result = TechnicalProposalSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.poDecision).toBeNull();
      expect(result.data.operatorDecision).toBeNull();
      expect(result.data.priorRejectionId).toBeNull();
    }
  });

  it('accepts all valid proposal types', () => {
    for (const pt of ProposalTypeSchema.options) {
      const result = TechnicalProposalSchema.safeParse(makeProposalData({ proposalType: pt }));
      expect(result.success).toBe(true);
    }
  });

  it('accepts all valid statuses', () => {
    for (const s of TechProposalStatusSchema.options) {
      const result = TechnicalProposalSchema.safeParse(makeProposalData({ status: s }));
      expect(result.success).toBe(true);
    }
  });
});

describe('TechnicalEnrichmentSchema', () => {
  it('parses valid enrichment', () => {
    const result = TechnicalEnrichmentSchema.safeParse({
      id: crypto.randomUUID(),
      proposalId: crypto.randomUUID(),
      effortEstimate: '3 days',
      dependencies: ['lodash@4.x'],
      technicalRisks: ['API breakage'],
      prerequisites: ['#123'],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts unassessed effort', () => {
    const result = TechnicalEnrichmentSchema.safeParse({
      id: crypto.randomUUID(),
      proposalId: crypto.randomUUID(),
      effortEstimate: 'unassessed',
      dependencies: [],
      technicalRisks: [],
      prerequisites: [],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('SignalDigestSchema', () => {
  it('parses minimal digest with defaults', () => {
    const result = SignalDigestSchema.safeParse({
      id: crypto.randomUUID(),
      trigger: 'scheduled',
      assembledAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewFindings).toEqual([]);
      expect(result.data.missingSources).toEqual([]);
    }
  });

  it('parses full digest', () => {
    const result = SignalDigestSchema.safeParse({
      id: crypto.randomUUID(),
      trigger: 'run_failure',
      reviewFindings: [{ recordId: 'r1', description: 'test', severity: 5, artifactPatterns: ['src/'] }],
      runOutcomes: [{ runId: 'run1', status: 'failed', failureReason: 'timeout' }],
      driftIndicators: [{ specId: 'STACK-1', codePath: 'src/foo.ts', issue: 'missing' }],
      deferredWork: [{ directory: 'src/', count: 5, markers: ['TODO'] }],
      testHealth: [{ area: 'validation', passRate: 0.95, trend: 'stable' }],
      dependencyRisks: [{ packageName: 'foo', currentVersion: '1.0.0', severity: 'high', advisory: 'CVE-123' }],
      activeProposals: [],
      priorRejections: [],
      missingSources: ['npm_audit'],
      assembledAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('TechLeadOutputSchema', () => {
  it('parses empty output with defaults', () => {
    const result = TechLeadOutputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposals).toEqual([]);
      expect(result.data.protocolTriggers).toEqual([]);
      expect(result.data.triageDecisions).toEqual([]);
    }
  });

  it('accepts valid triage decisions', () => {
    const result = TechLeadOutputSchema.safeParse({
      triageDecisions: [
        { issueNumber: 1, verdict: 'approve', reason: 'Clear finding' },
        { issueNumber: 2, verdict: 'promote', reason: 'High impact', newSeverity: 'P1' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid protocol triggers', () => {
    const result = TechLeadOutputSchema.safeParse({
      protocolTriggers: ['escalation', 'batch_planning'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid protocol trigger', () => {
    const result = TechLeadOutputSchema.safeParse({
      protocolTriggers: ['invalid_protocol'],
    });
    expect(result.success).toBe(false);
  });
});

describe('TechLeadRetrospectiveOutputSchema', () => {
  it('parses with pitfalls', () => {
    const result = TechLeadRetrospectiveOutputSchema.safeParse({
      pitfalls: [{
        artifactPatterns: ['src/validation/'],
        description: 'Missing error handling',
        severity: 7,
        rootCauseTag: 'error-handling',
      }],
      observations: ['Test coverage dropped in Q1'],
    });
    expect(result.success).toBe(true);
  });
});

describe('MetricDataPointSchema', () => {
  it('parses with null metrics', () => {
    const result = MetricDataPointSchema.safeParse({
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findingToFixRate).toBeNull();
    }
  });
});

describe('ProtocolExchangeSchema', () => {
  it('parses valid exchange', () => {
    const result = ProtocolExchangeSchema.safeParse({
      id: crypto.randomUUID(),
      protocolType: 'batch_planning',
      steps: [{ agentType: 'po', output: { items: [] }, at: new Date().toISOString() }],
      outcome: null,
      startedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});
