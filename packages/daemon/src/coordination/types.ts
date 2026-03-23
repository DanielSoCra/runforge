// src/coordination/types.ts — Coordination entity schemas (Zod) + inferred types
import { z } from 'zod';

// --- Proposal ---

export const ProposalStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'expired']);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  rationale: z.string(),
  scope: z.enum(['small', 'medium', 'large']),
  status: ProposalStatusSchema,
  relatedSpecs: z.array(z.string()).default([]),
  relatedIssues: z.array(z.number()).default([]),
  issueNumber: z.number().nullable(),
  approvedBy: z.string().nullable().default(null),
  decisionNotes: z.string().nullable().default(null),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable().default(null),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// --- Batch ---

export const BatchStatusSchema = z.enum(['planning', 'active', 'completed', 'cancelled']);
export type BatchStatus = z.infer<typeof BatchStatusSchema>;

export const BatchEventSchema = z.enum(['finalize', 'all_merged', 'cancel']);
export type BatchEvent = z.infer<typeof BatchEventSchema>;

export const batchTransitions: Record<BatchStatus, Partial<Record<BatchEvent, BatchStatus>>> = {
  planning: { finalize: 'active' },
  active: { all_merged: 'completed', cancel: 'cancelled' },
  completed: {},
  cancelled: {},
};

export const BatchItemStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'skipped', 'failed']);
export type BatchItemStatus = z.infer<typeof BatchItemStatusSchema>;

export const BatchItemSchema = z.object({
  id: z.string().uuid(),
  issueNumber: z.number(),
  repoKey: z.string().optional(), // "owner/name" for per-repo concurrency limits
  status: BatchItemStatusSchema,
  dependencies: z.array(z.string().uuid()).default([]),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

export const BatchSchema = z.object({
  id: z.string().uuid(),
  status: BatchStatusSchema,
  targetWorkerCount: z.number().int().min(1),
  budgetEstimate: z.number().nonnegative(),
  items: z.array(BatchItemSchema),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable().default(null),
  completedAt: z.string().datetime().nullable().default(null),
});
export type Batch = z.infer<typeof BatchSchema>;

// --- WorkerClaim ---

export const AgentTypeSchema = z.enum(['worker', 'reviewer', 'po', 'planner', 'codebase-reviewer']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const ClaimStatusSchema = z.enum(['claimed', 'in_progress', 'paused', 'pr_opened', 'completed', 'failed']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ACTIVE_CLAIM_STATUSES: ClaimStatus[] = ['claimed', 'in_progress', 'paused', 'pr_opened'];

export const WorkerClaimSchema = z.object({
  id: z.string().uuid(),
  issueNumber: z.number(),
  attempt: z.number().int().min(1),
  batchItemId: z.string().uuid().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  worktreePath: z.string().nullable().default(null),
  prNumber: z.number().nullable().default(null),
  agentType: AgentTypeSchema,
  status: ClaimStatusSchema,
  failureReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkerClaim = z.infer<typeof WorkerClaimSchema>;

// --- MergeQueueEntry ---

export const MergePhaseSchema = z.enum(['queued', 'rebasing', 'merging', 'validating', 'reverted']);
export type MergePhase = z.infer<typeof MergePhaseSchema>;

export const MergeStatusSchema = z.enum(['queued', 'merging', 'merged', 'failed', 'blocked', 'needs_human']);
export type MergeStatus = z.infer<typeof MergeStatusSchema>;

export const MergeQueueEntrySchema = z.object({
  id: z.string().uuid(),
  prNumber: z.number(),
  claimId: z.string().uuid(),
  issueNumber: z.number(),
  headRef: z.string(),
  batchId: z.string().uuid().nullable().default(null),
  dependencies: z.array(z.string().uuid()).default([]),
  priority: z.number().int().default(0),
  mergePhase: MergePhaseSchema,
  status: MergeStatusSchema,
  mergeCommit: z.string().nullable().default(null),
  attempts: z.number().int().default(0),
  lastFailureReason: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>;

// --- IdeaSubmission ---

export const IdeaSubmissionSchema = z.object({
  id: z.string().uuid(),
  submittedBy: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'processed']),
  proposalId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type IdeaSubmission = z.infer<typeof IdeaSubmissionSchema>;

// --- InferenceContext ---

export const DecisionTypeSchema = z.enum([
  'stuck_detection',
  'retry_skip_replan',
  'impediment_routing',
  'batch_rebalancing',
]);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const InferenceContextSchema = z.object({
  decisionType: DecisionTypeSchema,
  workItemId: z.string().nullable(),
  stateSnapshot: z.record(z.string(), z.unknown()),
  recentActivity: z.array(z.unknown()).max(10),
  failureReason: z.string().nullable().default(null),
});
export type InferenceContext = z.infer<typeof InferenceContextSchema>;

// --- InferenceDecision ---

export const InferenceDecisionSchema = z.object({
  decisionType: DecisionTypeSchema,
  chosenAction: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  timestamp: z.string().datetime().optional(),
  degraded: z.boolean().default(false),
});
export type InferenceDecision = z.infer<typeof InferenceDecisionSchema>;

// --- Helper: check if claim status is active ---

export function isActiveClaimStatus(status: ClaimStatus): boolean {
  return ACTIVE_CLAIM_STATUSES.includes(status);
}

// --- Helper: terminal-satisfied status for dependency resolution ---

const TERMINAL_SATISFIED: BatchItemStatus[] = ['completed', 'skipped'];

export function isTerminalSatisfied(status: BatchItemStatus): boolean {
  return TERMINAL_SATISFIED.includes(status);
}
