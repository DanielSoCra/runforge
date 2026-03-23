// src/validation/reviewer-session.ts
import { z } from 'zod';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { GateType, GateResult, ReviewFinding } from '../types.js';
import { SessionError } from '../session-runtime/session-error.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';

export const DiscoveredIssueSchema = z.object({
  artifactPatterns: z.array(z.string()),
  description: z.string(),
});

export const ReviewFindingsSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['critical', 'important', 'minor']),
    location: z.string(),
    description: z.string(),
  })),
  summary: z.string(),
  approved: z.boolean(),
  discoveredIssues: z.array(DiscoveredIssueSchema).optional(),
});

export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;
export type DiscoveredIssue = z.infer<typeof DiscoveredIssueSchema>;

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
  activePlugins?: Array<{ id: string; activatedAt: string }>,
): { type: GateType; execute: (cwd: string) => Promise<GateResult> } {
  return {
    type,
    async execute(cwd: string): Promise<GateResult> {
      const variables: Record<string, string> = { rubric, cwd };
      variables.diff = diff ?? '(diff unavailable — git diff failed or returned no output)';
      variables.specs = specs || 'No spec content available for this review.';

      const sessionOpts = {
        variables,
        workspacePath: cwd,
        activePlugins,
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
          // Propagate budget/rate-limit/containment signals immediately — never consume a retry attempt.
          // ARCH-AC-OPERATIONAL-SAFETY invariant: "rate limit handling never consumes a retry attempt."
          if (result.error instanceof SessionError && (result.error.rateLimited || result.error.containmentBreach || result.error.message.startsWith('Budget exceeded'))) {
            return {
              gate: type,
              passed: false,
              findings: [{ severity: 'critical', location: 'session', description: result.error.message }],
            };
          }
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
          discoveredIssues: parsed.data.discoveredIssues,
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

/**
 * Extract discovered issues from a gate result for write-back to the knowledge store.
 * Returns only issues from gates that included discoveredIssues in their output.
 * Per L3 spec: discovered issues are stored as candidate observations (lifecycleStatus: 'candidate')
 * requiring Operator approval before becoming permanent knowledge.
 */
export function extractDiscoveredIssues(
  gateResult: GateResult & { discoveredIssues?: DiscoveredIssue[] },
): DiscoveredIssue[] {
  return gateResult.discoveredIssues ?? [];
}
