// src/coordination/tech-lead/schemas.ts — Zod schemas for Tech Lead agent data models
import { z } from 'zod';

// --- Proposal Types ---

export const ProposalTypeSchema = z.enum([
  'debt_reduction',
  'quality_improvement',
  'architecture_concern',
  'dependency_update',
  'failure_investigation',
]);
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

// --- Proposal Status FSM ---

export const TechProposalStatusSchema = z.enum([
  'generated',
  'forwarded',
  'rejected_by_po',
  'pending_operator',
  'approved',
  'rejected_by_operator',
  'expired',
]);
export type TechProposalStatus = z.infer<typeof TechProposalStatusSchema>;

export const TechProposalEventSchema = z.enum([
  'po_forward',
  'po_reject',
  'operator_view',
  'operator_approve',
  'operator_reject',
  'expire',
]);
export type TechProposalEvent = z.infer<typeof TechProposalEventSchema>;

// --- Evidence ---

export const EvidenceEntrySchema = z.object({
  signal: z.string(),
  detail: z.string(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

// --- PO Decision ---

export const PODecisionSchema = z.object({
  verdict: z.enum(['forward', 'reject']),
  priority: z.string().optional(),
  reason: z.string(),
  decidedAt: z.string().datetime(),
});
export type PODecision = z.infer<typeof PODecisionSchema>;

// --- Operator Decision ---

export const OperatorDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
  decidedAt: z.string().datetime(),
});
export type OperatorDecision = z.infer<typeof OperatorDecisionSchema>;

// --- TechnicalProposal ---

export const TechnicalProposalSchema = z.object({
  id: z.string().uuid(),
  proposalType: ProposalTypeSchema,
  title: z.string(),
  evidence: z.array(EvidenceEntrySchema),
  affectedAreas: z.array(z.string()),
  riskAssessment: z.string(),
  effortEstimate: z.union([z.string(), z.literal('unassessed')]),
  status: TechProposalStatusSchema,
  poDecision: PODecisionSchema.nullable().default(null),
  operatorDecision: OperatorDecisionSchema.nullable().default(null),
  priorRejectionId: z.string().uuid().nullable().default(null),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type TechnicalProposal = z.infer<typeof TechnicalProposalSchema>;

// --- TechnicalEnrichment ---

export const TechnicalEnrichmentSchema = z.object({
  id: z.string().uuid(),
  proposalId: z.string().uuid(),
  effortEstimate: z.union([z.string(), z.literal('unassessed')]),
  dependencies: z.array(z.string()),
  technicalRisks: z.array(z.string()),
  prerequisites: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type TechnicalEnrichment = z.infer<typeof TechnicalEnrichmentSchema>;

// --- Cycle Trigger ---

export const CycleTriggerSchema = z.enum([
  'scheduled',
  'run_failure',
  'new_findings',
  'retrospective_complete',
]);
export type CycleTrigger = z.infer<typeof CycleTriggerSchema>;

// --- Signal Digest sections ---

export const ReviewFindingEntrySchema = z.object({
  recordId: z.string(),
  description: z.string(),
  severity: z.number(),
  artifactPatterns: z.array(z.string()),
});

export const RunOutcomeEntrySchema = z.object({
  runId: z.string(),
  status: z.string(),
  failureReason: z.string().nullable().default(null),
  errorCategory: z.string().nullable().default(null),
  retryCount: z.number().default(0),
});

export const DriftIndicatorEntrySchema = z.object({
  specId: z.string(),
  codePath: z.string(),
  issue: z.string(),
});
export type DriftIndicatorEntry = z.infer<typeof DriftIndicatorEntrySchema>;

export const DeferredWorkEntrySchema = z.object({
  directory: z.string(),
  count: z.number(),
  markers: z.array(z.string()),
});
export type DeferredWorkEntry = z.infer<typeof DeferredWorkEntrySchema>;

export const TestHealthEntrySchema = z.object({
  area: z.string(),
  passRate: z.number(),
  trend: z.enum(['improving', 'stable', 'declining']),
});

export const DependencyRiskEntrySchema = z.object({
  packageName: z.string(),
  currentVersion: z.string(),
  severity: z.enum(['low', 'moderate', 'high', 'critical']),
  advisory: z.string(),
});
export type DependencyRiskEntry = z.infer<typeof DependencyRiskEntrySchema>;

// --- SignalDigest ---

export const SignalDigestSchema = z.object({
  id: z.string().uuid(),
  trigger: CycleTriggerSchema,
  reviewFindings: z.array(ReviewFindingEntrySchema).default([]),
  runOutcomes: z.array(RunOutcomeEntrySchema).default([]),
  driftIndicators: z.array(DriftIndicatorEntrySchema).default([]),
  deferredWork: z.array(DeferredWorkEntrySchema).default([]),
  testHealth: z.array(TestHealthEntrySchema).default([]),
  dependencyRisks: z.array(DependencyRiskEntrySchema).default([]),
  activeProposals: z.array(TechnicalProposalSchema).default([]),
  priorRejections: z.array(TechnicalProposalSchema).default([]),
  missingSources: z.array(z.string()).default([]),
  assembledAt: z.string().datetime(),
});
export type SignalDigest = z.infer<typeof SignalDigestSchema>;

// --- Protocol Exchange ---

export const ProtocolTypeSchema = z.enum([
  'proposal_enrichment',
  'batch_planning',
  'backlog_grooming',
  'escalation',
  'status_sync',
  'retrospective',
]);
export type ProtocolType = z.infer<typeof ProtocolTypeSchema>;

export const ProtocolStepSchema = z.object({
  agentType: z.string(),
  output: z.unknown(),
  at: z.string().datetime(),
});

export const ProtocolExchangeSchema = z.object({
  id: z.string().uuid(),
  protocolType: ProtocolTypeSchema,
  steps: z.array(ProtocolStepSchema).default([]),
  outcome: z.unknown().nullable().default(null),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type ProtocolExchange = z.infer<typeof ProtocolExchangeSchema>;

// --- Tech Lead Session Output ---

export const TechLeadOutputSchema = z.object({
  proposals: z.array(TechnicalProposalSchema).default([]),
  protocolTriggers: z.array(z.enum([
    'escalation',
    'batch_planning',
    'backlog_grooming',
    'retrospective',
  ])).default([]),
});
export type TechLeadOutput = z.infer<typeof TechLeadOutputSchema>;

// --- Retrospective Output ---

export const RetrospectivePitfallSchema = z.object({
  artifactPatterns: z.array(z.string()),
  description: z.string(),
  severity: z.number().min(1).max(10),
  rootCauseTag: z.string(),
});
export type RetrospectivePitfall = z.infer<typeof RetrospectivePitfallSchema>;

export const TechLeadRetrospectiveOutputSchema = z.object({
  pitfalls: z.array(RetrospectivePitfallSchema).default([]),
  observations: z.array(z.string()).default([]),
});
export type TechLeadRetrospectiveOutput = z.infer<typeof TechLeadRetrospectiveOutputSchema>;

// --- Metrics ---

export const MetricDataPointSchema = z.object({
  timestamp: z.string().datetime(),
  findingToFixRate: z.number().nullable().default(null),
  driftReduction: z.number().nullable().default(null),
  failureDetectionSpeedMs: z.number().nullable().default(null),
  repeatGotchaRate: z.number().nullable().default(null),
  dependencyResponseTimeMs: z.number().nullable().default(null),
});
export type MetricDataPoint = z.infer<typeof MetricDataPointSchema>;
