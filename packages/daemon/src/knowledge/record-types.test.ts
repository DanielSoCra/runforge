// src/knowledge/record-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  RecordType,
  LifecycleStatus,
  OriginType,
  PriorityTier,
  KnowledgeRecordSchema,
  type KnowledgeRecord,
} from './record-types.js';

describe('RecordType', () => {
  it('accepts valid record types', () => {
    expect(RecordType.parse('technical_pitfall')).toBe('technical_pitfall');
    expect(RecordType.parse('business_observation')).toBe('business_observation');
    expect(RecordType.parse('operator_correction')).toBe('operator_correction');
    expect(RecordType.parse('review_finding')).toBe('review_finding');
  });

  it('rejects invalid record type', () => {
    expect(() => RecordType.parse('unknown')).toThrow();
  });
});

describe('LifecycleStatus', () => {
  it('accepts valid lifecycle statuses', () => {
    expect(LifecycleStatus.parse('candidate')).toBe('candidate');
    expect(LifecycleStatus.parse('active')).toBe('active');
    expect(LifecycleStatus.parse('promoted')).toBe('promoted');
    expect(LifecycleStatus.parse('archived')).toBe('archived');
  });

  it('rejects invalid status', () => {
    expect(() => LifecycleStatus.parse('deleted')).toThrow();
  });
});

describe('OriginType', () => {
  it('accepts all four origin types', () => {
    expect(OriginType.parse('autonomous')).toBe('autonomous');
    expect(OriginType.parse('operator')).toBe('operator');
    expect(OriginType.parse('retrospective-tech-lead')).toBe('retrospective-tech-lead');
    expect(OriginType.parse('retrospective-po')).toBe('retrospective-po');
  });
});

describe('KnowledgeRecordSchema', () => {
  const validRecord: KnowledgeRecord = {
    id: 'abc-123',
    recordType: 'technical_pitfall',
    artifactPatterns: ['src/**/*.ts'],
    description: 'Always validate input',
    sourceId: 'issue-42',
    confidence: 0.9,
    createdAt: '2026-03-20T00:00:00Z',
    hitCount: 1,
    lifecycleStatus: 'active',
    originType: 'autonomous',
    priorityTier: 'normal',
  };

  it('validates a complete record', () => {
    const result = KnowledgeRecordSchema.safeParse(validRecord);
    expect(result.success).toBe(true);
  });

  it('validates a record with optional fields', () => {
    const record = {
      ...validRecord,
      rootCauseTag: 'race-condition-cleanup',
      reasoning: 'Discovered during worktree teardown',
      reviewedAt: '2026-03-21T00:00:00Z',
    };
    const result = KnowledgeRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootCauseTag).toBe('race-condition-cleanup');
      expect(result.data.reasoning).toBe('Discovered during worktree teardown');
    }
  });

  it('rejects record missing required fields', () => {
    const { id: _, ...noId } = validRecord;
    expect(KnowledgeRecordSchema.safeParse(noId).success).toBe(false);
  });

  it('rejects invalid recordType', () => {
    const bad = { ...validRecord, recordType: 'invalid' };
    expect(KnowledgeRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects invalid lifecycleStatus', () => {
    const bad = { ...validRecord, lifecycleStatus: 'deleted' };
    expect(KnowledgeRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative hitCount', () => {
    const bad = { ...validRecord, hitCount: -1 };
    expect(KnowledgeRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects confidence outside 0-1 range', () => {
    expect(KnowledgeRecordSchema.safeParse({ ...validRecord, confidence: 1.5 }).success).toBe(false);
    expect(KnowledgeRecordSchema.safeParse({ ...validRecord, confidence: -0.1 }).success).toBe(false);
  });

  it('defaults optional fields to undefined', () => {
    const result = KnowledgeRecordSchema.parse(validRecord);
    expect(result.rootCauseTag).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
    expect(result.reviewedAt).toBeUndefined();
  });
});
