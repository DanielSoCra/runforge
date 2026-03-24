// src/knowledge/record-types.ts
import { z } from 'zod';

export const RecordType = z.enum([
  'technical_pitfall',
  'business_observation',
  'operator_correction',
  'review_finding',
]);
export type RecordType = z.infer<typeof RecordType>;

export const LifecycleStatus = z.enum([
  'candidate',
  'active',
  'promoted',
  'archived',
]);
export type LifecycleStatus = z.infer<typeof LifecycleStatus>;

export const OriginType = z.enum([
  'autonomous',
  'operator',
  'retrospective-tech-lead',
  'retrospective-po',
]);
export type OriginType = z.infer<typeof OriginType>;

export const PriorityTier = z.enum(['normal', 'elevated']);
export type PriorityTier = z.infer<typeof PriorityTier>;

export const KnowledgeRecordSchema = z.object({
  id: z.string().min(1),
  recordType: RecordType,
  artifactPatterns: z.array(z.string()),
  description: z.string(),
  sourceId: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  hitCount: z.number().int().min(0),
  lifecycleStatus: LifecycleStatus,
  originType: OriginType,
  priorityTier: PriorityTier,
  rootCauseTag: z.string().optional(),
  reasoning: z.string().optional(),
  reviewedAt: z.string().optional(),
});

export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>;
