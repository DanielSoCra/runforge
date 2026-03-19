// src/validation/reviewer-session.ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { GateType, GateResult, ReviewFinding } from '../types.js';

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

const jsonSchema = JSON.stringify(zodToJsonSchema(ReviewFindingsSchema));

export function createReviewerGate(
  type: GateType,
  sessionType: 'reviewer-spec' | 'reviewer-quality' | 'reviewer-security',
  rubric: string,
  runtime: SessionRuntime,
  issueNumber: number,
): { type: GateType; execute: (cwd: string) => Promise<GateResult> } {
  return {
    type,
    async execute(cwd: string): Promise<GateResult> {
      const result = await runtime.spawnSession(
        sessionType,
        {
          variables: { rubric, cwd },
          workspacePath: cwd,
        },
        issueNumber,
        { jsonSchema },
      );

      if (!result.ok) {
        return {
          gate: type,
          passed: false,
          findings: [{ severity: 'critical', location: 'session', description: result.error.message }],
        };
      }

      // Parse structured output
      const parsed = ReviewFindingsSchema.safeParse(result.value.structuredData);
      if (!parsed.success) {
        // Treat unparseable output as failure
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
    },
  };
}
