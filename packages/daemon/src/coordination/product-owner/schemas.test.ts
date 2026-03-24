// src/coordination/product-owner/schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  ProposalTypeSchema,
  RawProposalSchema,
  SpecGapEntrySchema,
  SignalSnapshotSchema,
  POAnalysisOutputSchema,
  POEnrichmentReviewSchema,
  POBatchPlanningOutputSchema,
  POBacklogGroomingOutputSchema,
  POStatusSyncOutputSchema,
  PORetrospectiveOutputSchema,
  POEscalationInitiateSchema,
  POEscalationResponseSchema,
  POMetricDataPointSchema,
  PROTOCOL_OUTPUT_SCHEMAS,
} from './schemas.js';

function makeRawProposal(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Advance FUNC-AC-LEARNING to L2',
    rationale: 'L1 spec exists but no L2 architecture — pipeline gap',
    proposalType: 'spec_advancement',
    relatedRefs: ['FUNC-AC-LEARNING'],
    estimatedScope: 'medium',
    ...overrides,
  };
}

describe('ProposalTypeSchema', () => {
  it('accepts all valid types', () => {
    for (const t of ProposalTypeSchema.options) {
      expect(ProposalTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('rejects invalid type', () => {
    expect(ProposalTypeSchema.safeParse('feature_request').success).toBe(false);
  });
});

describe('RawProposalSchema', () => {
  it('parses valid proposal', () => {
    const result = RawProposalSchema.safeParse(makeRawProposal());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Advance FUNC-AC-LEARNING to L2');
      expect(result.data.proposalType).toBe('spec_advancement');
    }
  });

  it('accepts all proposal types', () => {
    for (const pt of ProposalTypeSchema.options) {
      const result = RawProposalSchema.safeParse(makeRawProposal({ proposalType: pt }));
      expect(result.success).toBe(true);
    }
  });

  it('accepts all scope values', () => {
    for (const scope of ['small', 'medium', 'large']) {
      const result = RawProposalSchema.safeParse(makeRawProposal({ estimatedScope: scope }));
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid scope', () => {
    expect(RawProposalSchema.safeParse(makeRawProposal({ estimatedScope: 'huge' })).success).toBe(false);
  });

  it('rejects missing title', () => {
    const data = makeRawProposal();
    delete (data as Record<string, unknown>).title;
    expect(RawProposalSchema.safeParse(data).success).toBe(false);
  });
});

describe('SpecGapEntrySchema', () => {
  it('parses valid entry', () => {
    const result = SpecGapEntrySchema.safeParse({
      specId: 'FUNC-AC-LEARNING',
      hasL1: true,
      hasL2: false,
      hasL3: false,
      isImplemented: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('SignalSnapshotSchema', () => {
  it('parses minimal snapshot with defaults', () => {
    const result = SignalSnapshotSchema.safeParse({
      cycleTimestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specPipeline).toEqual([]);
      expect(result.data.deliverySummary).toEqual([]);
      expect(result.data.backlog).toEqual([]);
      expect(result.data.activeProposals).toEqual([]);
      expect(result.data.proposalHistory).toEqual([]);
      expect(result.data.ideaInbox).toEqual([]);
      expect(result.data.missingSources).toEqual([]);
    }
  });

  it('parses full snapshot', () => {
    const result = SignalSnapshotSchema.safeParse({
      cycleTimestamp: new Date().toISOString(),
      specPipeline: [{ specId: 'FUNC-AC-LEARNING', hasL1: true, hasL2: false, hasL3: false, isImplemented: false }],
      deliverySummary: [{ repo: 'auto-claude', passRate: 0.85, completionCount: 12 }],
      backlog: [{ issueNumber: 42, title: 'Test', labels: ['bug'], ageDays: 5, isStale: false }],
      activeProposals: [{ id: 'p1', title: 'Test', status: 'proposed', proposalType: 'spec_advancement' }],
      proposalHistory: [{ id: 'p0', title: 'Old', status: 'approved', proposalType: 'spec_advancement', outcome: 'approved', operatorReason: null }],
      ideaInbox: [{ id: 'i1', content: 'Add caching', submittedAt: new Date().toISOString() }],
      missingSources: ['npm_audit'],
    });
    expect(result.success).toBe(true);
  });
});

describe('POAnalysisOutputSchema', () => {
  it('parses empty output with defaults', () => {
    const result = POAnalysisOutputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposals).toEqual([]);
      expect(result.data.protocolTriggers).toEqual([]);
    }
  });

  it('parses output with proposals', () => {
    const result = POAnalysisOutputSchema.safeParse({
      proposals: [makeRawProposal()],
      protocolTriggers: ['backlog_grooming'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposals).toHaveLength(1);
    }
  });

  it('rejects invalid protocol trigger', () => {
    expect(POAnalysisOutputSchema.safeParse({
      protocolTriggers: ['invalid_trigger'],
    }).success).toBe(false);
  });
});

describe('POEnrichmentReviewSchema', () => {
  it('parses forward decision', () => {
    const result = POEnrichmentReviewSchema.safeParse({
      decision: 'forward',
      reason: 'High business value',
      scopeAdjustments: ['Reduce scope to L2 only'],
    });
    expect(result.success).toBe(true);
  });

  it('parses reject decision with default scope adjustments', () => {
    const result = POEnrichmentReviewSchema.safeParse({
      decision: 'reject',
      reason: 'Low priority',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopeAdjustments).toEqual([]);
    }
  });
});

describe('POBatchPlanningOutputSchema', () => {
  it('parses prioritized items', () => {
    const result = POBatchPlanningOutputSchema.safeParse({
      prioritizedItems: [
        { ref: '#42', priority: 1, rationale: 'Blocks other work' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('POBacklogGroomingOutputSchema', () => {
  it('parses re-prioritized backlog', () => {
    const result = POBacklogGroomingOutputSchema.safeParse({
      reprioritizedBacklog: [
        { ref: '#42', priority: 1, movement: 'up', rationale: 'New dependency cleared' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('POStatusSyncOutputSchema', () => {
  it('parses status sync', () => {
    const result = POStatusSyncOutputSchema.safeParse({
      priorityChanges: ['#42 moved up due to operator request'],
      newIdeas: ['Caching layer for dashboard'],
      proposalOutcomes: ['Proposal P1 approved by operator'],
    });
    expect(result.success).toBe(true);
  });
});

describe('PORetrospectiveOutputSchema', () => {
  it('parses expectations vs actuals', () => {
    const result = PORetrospectiveOutputSchema.safeParse({
      expectationsVsActuals: [
        { item: '#42', expected: 'Complete in 1 batch', actual: 'Required 2 batches' },
      ],
      businessLessons: [
        { description: 'Spec advancement estimates too optimistic', artifactRefs: ['FUNC-AC-LEARNING'] },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('POEscalationInitiateSchema', () => {
  it('parses priority shift escalation', () => {
    const result = POEscalationInitiateSchema.safeParse({
      description: 'Operator submitted urgent idea',
      affectedBatchItems: ['#42', '#43'],
      urgency: 'high',
    });
    expect(result.success).toBe(true);
  });
});

describe('POEscalationResponseSchema', () => {
  it('parses escalation response', () => {
    const result = POEscalationResponseSchema.safeParse({
      chosenOption: 'retry with clarification',
      rationale: 'Spec ambiguity is fixable, retry is low-cost',
    });
    expect(result.success).toBe(true);
  });
});

describe('POMetricDataPointSchema', () => {
  it('parses with null metrics', () => {
    const result = POMetricDataPointSchema.safeParse({
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.proposalAcceptanceRate).toBeNull();
      expect(result.data.backlogThroughput).toBeNull();
      expect(result.data.staleDetectionLatencyMs).toBeNull();
      expect(result.data.specPipelineCoverage).toBeNull();
    }
  });

  it('parses full metrics', () => {
    const result = POMetricDataPointSchema.safeParse({
      timestamp: new Date().toISOString(),
      proposalAcceptanceRate: 0.75,
      backlogThroughput: 5,
      staleDetectionLatencyMs: 3600000,
      specPipelineCoverage: 0.6,
    });
    expect(result.success).toBe(true);
  });
});

describe('PROTOCOL_OUTPUT_SCHEMAS', () => {
  it('has an entry for each PO protocol type', () => {
    const expected = [
      'enrichment_review', 'batch_planning', 'backlog_grooming',
      'status_sync', 'retrospective', 'escalation_initiate', 'escalation_response',
    ];
    for (const key of expected) {
      expect(PROTOCOL_OUTPUT_SCHEMAS).toHaveProperty(key);
    }
  });
});
