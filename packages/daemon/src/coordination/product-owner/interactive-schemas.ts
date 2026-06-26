// packages/daemon/src/coordination/product-owner/interactive-schemas.ts
//
// Zod schemas for interactive PO shared state and session records.

import { z } from 'zod';

export const NeedsDiscussionItemSchema = z.object({
  id: z.string(),
  sourceType: z.enum(['finding', 'proposal', 'escalation', 'general']),
  sourceRef: z.string(),
  contextSummary: z.string(),
  status: z.enum(['pending', 'decided', 'deferred']),
  operatorDecision: z.string().nullable().default(null),
  decisionTimestamp: z.string().datetime().nullable().default(null),
  poCycleId: z.string(),
  createdAt: z.string().datetime(),
});
export type NeedsDiscussionItem = z.infer<typeof NeedsDiscussionItemSchema>;

export const AutonomousDecisionRecordSchema = z.object({
  id: z.string(),
  decisionType: z.enum([
    'finding_approved',
    'finding_rejected',
    'proposal_generated',
    'proposal_forwarded',
    'proposal_rejected',
    'priority_changed',
  ]),
  description: z.string(),
  affectedEntityRef: z.string(),
  poCycleId: z.string(),
  reviewed: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AutonomousDecisionRecord = z.infer<typeof AutonomousDecisionRecordSchema>;

export const SharedPOStateSchema = z.object({
  needsDiscussion: z.array(NeedsDiscussionItemSchema).default([]),
  autonomousDecisions: z.array(AutonomousDecisionRecordSchema).default([]),
  triageQueue: z.array(z.object({ findingRef: z.string(), summary: z.string() })).default([]),
  version: z.number().int().min(0),
  lastUpdated: z.string().datetime(),
});
export type SharedPOState = z.infer<typeof SharedPOStateSchema>;

export const SessionDecisionEntrySchema = z.object({
  itemId: z.string(),
  decision: z.string(),
  timestamp: z.string().datetime(),
});
export type SessionDecisionEntry = z.infer<typeof SessionDecisionEntrySchema>;

export const InteractiveSessionRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  endReason: z.enum(['explicit_close', 'timeout', 'error']),
  sessionRuntimeId: z.string(),
  decisions: z.array(SessionDecisionEntrySchema).default([]),
  autonomousDecisionsReviewed: z.number().int().default(0),
  needsDiscussionResolved: z.number().int().default(0),
  summary: z.string(),
});
export type InteractiveSessionRecord = z.infer<typeof InteractiveSessionRecordSchema>;

export const InteractiveSessionContextSchema = z.object({
  sharedState: SharedPOStateSchema,
  activeProposals: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    proposalType: z.string(),
  })).default([]),
  backlogSummary: z.array(z.object({
    issueNumber: z.number(),
    title: z.string(),
    labels: z.array(z.string()),
    ageDays: z.number(),
    isStale: z.boolean(),
  })).default([]),
});
export type InteractiveSessionContext = z.infer<typeof InteractiveSessionContextSchema>;
