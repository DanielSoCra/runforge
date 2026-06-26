// packages/daemon/src/compliance/schemas.ts
//
// Zod schemas for the compliance gate evaluator.

import { z } from 'zod';

export const RegulatedPathSchema = z.object({
  pattern: z.string().min(1),
  requiredReviewers: z.array(z.string().min(1)).default([]),
});
export type RegulatedPath = z.infer<typeof RegulatedPathSchema>;

export const ComplianceProfileSchema = z.object({
  regulatedPaths: z.array(RegulatedPathSchema).default([]),
});
export type ComplianceProfile = z.infer<typeof ComplianceProfileSchema>;

export const ComplianceReviewVerdictSchema = z.object({
  reviewerRoleId: z.string().min(1),
  verdict: z.enum(['pass', 'block']),
  reason: z.string().default(''),
  timestamp: z.string().datetime(),
});
export type ComplianceReviewVerdict = z.infer<typeof ComplianceReviewVerdictSchema>;

export const ComplianceEvaluationStatusSchema = z.enum(['proceed', 'hold', 'blocked']);
export type ComplianceEvaluationStatus = z.infer<typeof ComplianceEvaluationStatusSchema>;

export const ComplianceEvaluationSchema = z.object({
  status: ComplianceEvaluationStatusSchema,
  matchedPaths: z.array(z.string()),
  requiredReviewers: z.array(z.string()),
  verdicts: z.record(z.string(), ComplianceReviewVerdictSchema),
  missingReviewers: z.array(z.string()).default([]),
  blockingReviewers: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
});
export type ComplianceEvaluation = z.infer<typeof ComplianceEvaluationSchema>;
