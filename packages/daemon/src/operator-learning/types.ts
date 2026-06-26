// packages/daemon/src/operator-learning/types.ts
//
// Operator Behavioral Learning — data model and Zod schemas.
// Append-only observations → derived per-(class, context) preferences.

import { z } from 'zod';

export const RungSchema = z.enum(['surface', 'pre-fill', 'propose-ask-less']);
export type Rung = z.infer<typeof RungSchema>;

export const RungThresholdsSchema = z.object({
  preFill: z.object({
    minConfidence: z.number().min(0).max(1),
    minObservations: z.number().int().min(1),
    minDistinctSources: z.number().int().min(1),
  }),
  proposeAskLess: z.object({
    minConfidence: z.number().min(0).max(1),
    minObservations: z.number().int().min(1),
    minDistinctSources: z.number().int().min(1),
  }),
});
export type RungThresholds = z.infer<typeof RungThresholdsSchema>;

export const DecisionAnswerObservationSchema = z.object({
  kind: z.literal('decision_answer'),
  observationId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  sourceDecisionId: z.string().min(1),
  chosenOption: z.string().min(1),
  recommendedOption: z.string().optional(),
  matchedRecommendation: z.boolean(),
  sensitive: z.boolean().default(false),
  observedAt: z.number().int(),
});
export type DecisionAnswerObservation = z.infer<typeof DecisionAnswerObservationSchema>;

export const ReRankActionKindSchema = z.enum(['pin', 'mute', 'defer', 'reorder-to-top']);
export type ReRankActionKind = z.infer<typeof ReRankActionKindSchema>;

export const ReRankObservationSchema = z.object({
  kind: z.literal('rerank_action'),
  observationId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  action: ReRankActionKindSchema,
  priorPosition: z.number().int().optional(),
  resultingPosition: z.number().int().optional(),
  observedAt: z.number().int(),
});

export const SpecEditFingerprintSchema = z.object({
  changeKind: z.enum(['added_constraint', 'removed_step', 'reordered_section', 'changed_scope', 'other']),
  affectedSections: z.array(z.string()).default([]),
});
export type SpecEditFingerprint = z.infer<typeof SpecEditFingerprintSchema>;

export const SpecEditObservationSchema = z.object({
  kind: z.literal('spec_edit'),
  observationId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  fingerprint: SpecEditFingerprintSchema,
  observedAt: z.number().int(),
});

export const PreferenceResetEventSchema = z.object({
  kind: z.literal('preference_reset'),
  observationId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  observedAt: z.number().int(),
});

export const PreferenceRevertEventSchema = z.object({
  kind: z.literal('preference_revert'),
  observationId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  fleetWide: z.boolean().default(false),
  observedAt: z.number().int(),
});

export const ObservationSchema = z.discriminatedUnion('kind', [
  DecisionAnswerObservationSchema,
  ReRankObservationSchema,
  SpecEditObservationSchema,
  PreferenceResetEventSchema,
  PreferenceRevertEventSchema,
]);
export type Observation = z.infer<typeof ObservationSchema>;

export const PreferenceSchema = z.object({
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  confidence: z.number().min(0).max(1),
  mostFrequentChoice: z.string().optional(),
  rung: RungSchema,
  evidenceSummary: z.object({
    totalObservations: z.number().int(),
    matchingChoices: z.number().int(),
    contradictingChoices: z.number().int(),
    distinctSources: z.number().int(),
  }),
  updatedAt: z.number().int(),
});
export type Preference = z.infer<typeof PreferenceSchema>;

export const EvidenceSummarySchema = z.object({
  totalObservations: z.number().int(),
  matchingChoices: z.number().int(),
  contradictingChoices: z.number().int(),
  distinctSources: z.number().int(),
  mostFrequentChoice: z.string().optional(),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const RankingExplanationSchema = z.object({
  basePriority: z.number(),
  attentionWeight: z.number(),
  rung: RungSchema,
  confidence: z.number(),
  evidenceSummary: EvidenceSummarySchema,
});
export type RankingExplanation = z.infer<typeof RankingExplanationSchema>;

export const RankedItemSchema = z.object({
  decisionId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  basePriority: z.number(),
  score: z.number(),
  explanation: RankingExplanationSchema,
});
export type RankedItem = z.infer<typeof RankedItemSchema>;

export const InboxItemSchema = z.object({
  decisionId: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  basePriority: z.number(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const AskLessProposalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type AskLessProposalStatus = z.infer<typeof AskLessProposalStatusSchema>;

export const AskLessProposalSchema = z.object({
  id: z.string().min(1),
  decisionClass: z.string().min(1),
  context: z.string().min(1),
  proposedThreshold: z.number().int().min(0),
  evidence: EvidenceSummarySchema,
  status: AskLessProposalStatusSchema,
  createdAt: z.number().int(),
  approvedAt: z.number().int().optional(),
  cooldownUntil: z.number().int().optional(),
});
export type AskLessProposal = z.infer<typeof AskLessProposalSchema>;

export const OperatorLearningConfigSchema = z.object({
  logPath: z.string().min(1),
  proposalDir: z.string().min(1),
  thresholds: RungThresholdsSchema,
  guardedClasses: z.array(z.string().min(1)).default([]),
  attentionWindowMs: z.number().int().min(0).default(30 * 24 * 60 * 60 * 1000),
  rankingBoostScale: z.number().default(1.0),
  proposalCooldownMs: z.number().int().min(0).default(30 * 24 * 60 * 60 * 1000),
});
export type OperatorLearningConfig = z.infer<typeof OperatorLearningConfigSchema>;

export const DEFAULT_RUNG_THRESHOLDS: RungThresholds = {
  preFill: {
    minConfidence: 0.75,
    minObservations: 3,
    minDistinctSources: 2,
  },
  proposeAskLess: {
    minConfidence: 0.9,
    minObservations: 5,
    minDistinctSources: 3,
  },
};

export const DEFAULT_GUARDED_CLASSES: string[] = [
  'safety_critical',
  'sensitive_data',
  'compliance_gate',
  'specification_content',
  'production_release',
  // L2 architecture-gate and merge/integrate decisions retain operator
  // oversight: they must never silently auto-advance to pre-fill/ask-less.
  'l2_gate',
  'merge_decision',
];
