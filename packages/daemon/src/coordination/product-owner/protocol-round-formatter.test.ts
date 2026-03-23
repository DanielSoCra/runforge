// src/coordination/product-owner/protocol-round-formatter.test.ts
import { describe, it, expect } from 'vitest';
import {
  formatEnrichmentReviewInput,
  formatBatchPlanningInput,
  formatBacklogGroomingInput,
  formatStatusSyncInput,
  formatRetrospectiveInput,
  formatEscalationResponseInput,
} from './protocol-round-formatter.js';

describe('formatEnrichmentReviewInput', () => {
  it('formats proposal with tech lead assessment', () => {
    const result = formatEnrichmentReviewInput(
      { title: 'Test', rationale: 'Gap', proposalType: 'spec_advancement', relatedRefs: [], estimatedScope: 'small' as const },
      { effortEstimate: '2 days', dependencies: ['lodash'], technicalRisks: ['API breakage'], prerequisites: ['#100'] },
    );
    expect(result).toContain('Test');
    expect(result).toContain('2 days');
    expect(result).toContain('API breakage');
  });

  it('handles unassessed tech lead input', () => {
    const result = formatEnrichmentReviewInput(
      { title: 'Test', rationale: 'Gap', proposalType: 'spec_advancement', relatedRefs: [], estimatedScope: 'small' as const },
      { effortEstimate: 'unassessed', dependencies: [], technicalRisks: [], prerequisites: [] },
    );
    expect(result).toContain('unassessed');
  });
});

describe('formatBatchPlanningInput', () => {
  it('formats backlog items for planning', () => {
    const result = formatBatchPlanningInput([
      { issueNumber: 42, title: 'Fix bug', labels: ['bug'], ageDays: 3, isStale: false },
      { issueNumber: 43, title: 'Add feature', labels: ['feature'], ageDays: 1, isStale: false },
    ]);
    expect(result).toContain('#42');
    expect(result).toContain('#43');
  });
});

describe('formatBacklogGroomingInput', () => {
  it('formats backlog with new signals', () => {
    const result = formatBacklogGroomingInput(
      [{ issueNumber: 42, title: 'Fix bug', labels: ['bug'], ageDays: 3, isStale: false }],
      ['New spec FUNC-AC-LEARNING approved', 'Operator submitted idea'],
    );
    expect(result).toContain('#42');
    expect(result).toContain('FUNC-AC-LEARNING');
  });
});

describe('formatStatusSyncInput', () => {
  it('formats tech lead report for PO', () => {
    const result = formatStatusSyncInput({
      activeWork: ['#42 in progress'],
      stuckItems: ['#43 blocked'],
      completedItems: ['#41'],
      resourceUtilization: '3/5 slots',
    });
    expect(result).toContain('#42');
    expect(result).toContain('#43 blocked');
  });
});

describe('formatRetrospectiveInput', () => {
  it('formats batch results for PO retrospective', () => {
    const result = formatRetrospectiveInput({
      batchId: 'batch-1',
      plannedItems: ['#42', '#43'],
      completedItems: ['#42'],
      failedItems: ['#43'],
    });
    expect(result).toContain('batch-1');
    expect(result).toContain('#42');
    expect(result).toContain('#43');
  });
});

describe('formatEscalationResponseInput', () => {
  it('formats tech lead escalation for PO decision', () => {
    const result = formatEscalationResponseInput({
      description: 'Spec ambiguity in error handling',
      options: ['Retry with clarification', 'Skip item', 'Fix spec first'],
    });
    expect(result).toContain('Spec ambiguity');
    expect(result).toContain('Retry with clarification');
  });
});
