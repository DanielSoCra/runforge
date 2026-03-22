// src/validation/reviewer-session.ts
import { z } from 'zod';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { GateType, GateResult, ReviewFinding } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';

export const ReviewFindingsSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['critical', 'important', 'minor']),
    location: z.string(),
    description: z.string(),
  })),
  summary: z.string(),
  approved: z.boolean(),
});

export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;

const jsonSchema = JSON.stringify(z.toJSONSchema(ReviewFindingsSchema));

export function createReviewerGate(
  type: GateType,
  sessionType: 'reviewer-spec' | 'reviewer-quality' | 'reviewer-security',
  rubric: string,
  runtime: SessionRuntime,
  issueNumber: number,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  diff?: string,
  specs?: string,
): { type: GateType; execute: (cwd: string) => Promise<GateResult> } {
  return {
    type,
    async execute(cwd: string): Promise<GateResult> {
      const variables: Record<string, string> = { rubric, cwd };
      if (diff !== undefined) variables.diff = diff;
      variables.specs = specs || 'No spec content available for this review.';

      const sessionOpts = {
        variables,
        workspacePath: cwd,
      };

      // Retry logic: one retry on session failure or invalid structured output
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runtime.spawnSession(
          sessionType,
          sessionOpts,
          issueNumber,
          { jsonSchema },
          runWriter,
          runId,
        );

        if (!result.ok) {
          if (attempt === 0) continue; // retry once
          return {
            gate: type,
            passed: false,
            findings: [{ severity: 'critical', location: 'session', description: result.error.message }],
          };
        }

        // Parse structured output
        const parsed = ReviewFindingsSchema.safeParse(result.value.structuredData);
        if (!parsed.success) {
          if (attempt === 0) continue; // retry once
          return {
            gate: type,
            passed: false,
            findings: [{ severity: 'critical', location: 'output', description: 'Reviewer produced invalid structured output' }],
          };
        }

        const hasCritical = parsed.data.findings.some((f) => f.severity === 'critical');
        return {
          gate: type,
          passed: parsed.data.approved && !hasCritical,
          findings: parsed.data.findings as ReviewFinding[],
        };
      }

      // Unreachable, but TypeScript needs it
      return {
        gate: type,
        passed: false,
        findings: [{ severity: 'critical', location: 'session', description: 'Unexpected retry exhaustion' }],
      };
    },
  };
}
