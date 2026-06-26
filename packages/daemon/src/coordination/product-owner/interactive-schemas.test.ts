// packages/daemon/src/coordination/product-owner/interactive-schemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  SharedPOStateSchema,
  InteractiveSessionRecordSchema,
  InteractiveSessionContextSchema,
  NeedsDiscussionItemSchema,
  AutonomousDecisionRecordSchema,
} from './interactive-schemas.js';

describe('NeedsDiscussionItemSchema', () => {
  it('accepts a valid pending item', () => {
    const result = NeedsDiscussionItemSchema.safeParse({
      id: 'item-1',
      sourceType: 'finding',
      sourceRef: 'ref-1',
      contextSummary: 'summary',
      status: 'pending',
      operatorDecision: null,
      decisionTimestamp: null,
      poCycleId: 'cycle-1',
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('AutonomousDecisionRecordSchema', () => {
  it('accepts a valid decision record', () => {
    const result = AutonomousDecisionRecordSchema.safeParse({
      id: 'dec-1',
      decisionType: 'finding_approved',
      description: 'desc',
      affectedEntityRef: 'ref-1',
      poCycleId: 'cycle-1',
      reviewed: false,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('SharedPOStateSchema', () => {
  it('parses empty state with defaults', () => {
    const now = new Date().toISOString();
    const result = SharedPOStateSchema.safeParse({
      version: 0,
      lastUpdated: now,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.needsDiscussion).toEqual([]);
      expect(result.data.autonomousDecisions).toEqual([]);
      expect(result.data.triageQueue).toEqual([]);
    }
  });
});

describe('InteractiveSessionRecordSchema', () => {
  it('accepts an active session record', () => {
    const result = InteractiveSessionRecordSchema.safeParse({
      id: 's1',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: 'explicit_close',
      sessionRuntimeId: 'runtime-1',
      summary: '',
    });
    expect(result.success).toBe(true);
  });
});

describe('InteractiveSessionContextSchema', () => {
  it('accepts minimal context', () => {
    const result = InteractiveSessionContextSchema.safeParse({
      sharedState: {
        needsDiscussion: [],
        autonomousDecisions: [],
        triageQueue: [],
        version: 0,
        lastUpdated: new Date().toISOString(),
      },
      activeProposals: [],
      backlogSummary: [],
    });
    expect(result.success).toBe(true);
  });
});
