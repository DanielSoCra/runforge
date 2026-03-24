// src/coordination/product-owner/schemas.ts — Zod schemas for Product Owner agent data models
import { z } from 'zod';

// --- Proposal Types ---

export const ProposalTypeSchema = z.enum([
  'spec_advancement',
  'stale_investigation',
  'backlog_prioritization',
  'operator_idea_refinement',
]);
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

// --- RawProposal (PO session output — Coordinator adds id, status, timestamps) ---

export const RawProposalSchema = z.object({
  title: z.string(),
  rationale: z.string(),
  proposalType: ProposalTypeSchema,
  relatedRefs: z.array(z.string()),
  estimatedScope: z.enum(['small', 'medium', 'large']),
});
export type RawProposal = z.infer<typeof RawProposalSchema>;

// --- SpecGapEntry (pipeline gap analysis) ---

export const SpecGapEntrySchema = z.object({
  specId: z.string(),
  hasL1: z.boolean(),
  hasL2: z.boolean(),
  hasL3: z.boolean(),
  isImplemented: z.boolean(),
  staleDays: z.number().optional(),
});
export type SpecGapEntry = z.infer<typeof SpecGapEntrySchema>;

// --- SignalSnapshot sections ---

export const DeliverySummaryEntrySchema = z.object({
  repo: z.string(),
  passRate: z.number(),
  completionCount: z.number(),
});

export const BacklogItemSchema = z.object({
  issueNumber: z.number(),
  title: z.string(),
  labels: z.array(z.string()),
  ageDays: z.number(),
  isStale: z.boolean(),
});

export const ActiveProposalSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  proposalType: z.string(),
});

export const ProposalHistoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  proposalType: z.string(),
  outcome: z.string(),
  operatorReason: z.string().nullable().default(null),
});

export const IdeaSubmissionSchema = z.object({
  id: z.string(),
  content: z.string(),
  submittedAt: z.string().datetime(),
});
export type IdeaSubmission = z.infer<typeof IdeaSubmissionSchema>;

// --- SignalSnapshot ---

export const SignalSnapshotSchema = z.object({
  cycleTimestamp: z.string().datetime(),
  specPipeline: z.array(SpecGapEntrySchema).default([]),
  deliverySummary: z.array(DeliverySummaryEntrySchema).default([]),
  backlog: z.array(BacklogItemSchema).default([]),
  activeProposals: z.array(ActiveProposalSummarySchema).default([]),
  proposalHistory: z.array(ProposalHistoryEntrySchema).default([]),
  ideaInbox: z.array(IdeaSubmissionSchema).default([]),
  missingSources: z.array(z.string()).default([]),
});
export type SignalSnapshot = z.infer<typeof SignalSnapshotSchema>;

// --- PO Analysis Output (standalone cycle) ---

export const POAnalysisOutputSchema = z.object({
  proposals: z.array(RawProposalSchema).default([]),
  protocolTriggers: z.array(z.enum(['backlog_grooming', 'escalation'])).default([]),
});
export type POAnalysisOutput = z.infer<typeof POAnalysisOutputSchema>;

// --- Protocol Round Output Schemas ---

export const POEnrichmentReviewSchema = z.object({
  decision: z.enum(['forward', 'reject']),
  reason: z.string(),
  scopeAdjustments: z.array(z.string()).default([]),
});
export type POEnrichmentReview = z.infer<typeof POEnrichmentReviewSchema>;

export const POBatchPlanningOutputSchema = z.object({
  prioritizedItems: z.array(z.object({
    ref: z.string(),
    priority: z.number(),
    rationale: z.string(),
  })),
});
export type POBatchPlanningOutput = z.infer<typeof POBatchPlanningOutputSchema>;

export const POBacklogGroomingOutputSchema = z.object({
  reprioritizedBacklog: z.array(z.object({
    ref: z.string(),
    priority: z.number(),
    movement: z.enum(['up', 'down', 'stable', 'removed']),
    rationale: z.string(),
  })),
});
export type POBacklogGroomingOutput = z.infer<typeof POBacklogGroomingOutputSchema>;

export const POStatusSyncOutputSchema = z.object({
  priorityChanges: z.array(z.string()).default([]),
  newIdeas: z.array(z.string()).default([]),
  proposalOutcomes: z.array(z.string()).default([]),
});
export type POStatusSyncOutput = z.infer<typeof POStatusSyncOutputSchema>;

export const PORetrospectiveOutputSchema = z.object({
  expectationsVsActuals: z.array(z.object({
    item: z.string(),
    expected: z.string(),
    actual: z.string(),
  })),
  businessLessons: z.array(z.object({
    description: z.string(),
    artifactRefs: z.array(z.string()),
  })),
});
export type PORetrospectiveOutput = z.infer<typeof PORetrospectiveOutputSchema>;

export const POEscalationInitiateSchema = z.object({
  description: z.string(),
  affectedBatchItems: z.array(z.string()),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
});
export type POEscalationInitiate = z.infer<typeof POEscalationInitiateSchema>;

export const POEscalationResponseSchema = z.object({
  chosenOption: z.string(),
  rationale: z.string(),
});
export type POEscalationResponse = z.infer<typeof POEscalationResponseSchema>;

// --- Protocol output schema lookup ---

export const PROTOCOL_OUTPUT_SCHEMAS: Record<string, z.ZodSchema> = {
  enrichment_review: POEnrichmentReviewSchema,
  batch_planning: POBatchPlanningOutputSchema,
  backlog_grooming: POBacklogGroomingOutputSchema,
  status_sync: POStatusSyncOutputSchema,
  retrospective: PORetrospectiveOutputSchema,
  escalation_initiate: POEscalationInitiateSchema,
  escalation_response: POEscalationResponseSchema,
};

// --- Metrics ---

export const POMetricDataPointSchema = z.object({
  timestamp: z.string().datetime(),
  proposalAcceptanceRate: z.number().nullable().default(null),
  backlogThroughput: z.number().nullable().default(null),
  staleDetectionLatencyMs: z.number().nullable().default(null),
  specPipelineCoverage: z.number().nullable().default(null),
});
export type POMetricDataPoint = z.infer<typeof POMetricDataPointSchema>;
