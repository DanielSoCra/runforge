// src/validation/reviewer-session.ts
import { z } from 'zod';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { GateType, GateResult, ReviewFinding, DiscoveredIssue } from '../types.js';
import { SessionError } from '../session-runtime/session-error.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';

export const DiscoveredIssueSchema = z.object({
  artifactPatterns: z.array(z.string()),
  description: z.string(),
});

export const ReviewFindingsSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['critical', 'important', 'minor']),
    location: z.string().optional().default('output'),
    description: z.string(),
  })),
  summary: z.string(),
  approved: z.boolean(),
  discoveredIssues: z.array(DiscoveredIssueSchema).optional(),
});

export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;

const jsonSchema = JSON.stringify(z.toJSONSchema(ReviewFindingsSchema));

const SEVERITY_MAP: Record<string, string> = {
  high: 'critical', severe: 'critical', blocker: 'critical',
  medium: 'important', moderate: 'important', significant: 'important',
  low: 'minor', info: 'minor', informational: 'minor', trivial: 'minor',
};

function normalizeSeverities(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return data;
  return {
    ...obj,
    findings: obj.findings.map((f: unknown) => {
      if (f === null || typeof f !== 'object') return f;
      const finding = f as Record<string, unknown>;
      const sev = typeof finding.severity === 'string' ? finding.severity.toLowerCase() : '';
      const normalized = SEVERITY_MAP[sev];
      return normalized ? { ...finding, severity: normalized } : finding;
    }),
  };
}

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
  knowledgeContext?: string,
): { type: GateType; execute: (cwd: string) => Promise<GateResult> } {
  return {
    type,
    async execute(cwd: string): Promise<GateResult> {
      const variables: Record<string, string> = { rubric, cwd };
      variables.diff = diff ?? '(diff unavailable — git diff failed or returned no output)';
      // Only inject specs for reviewer-spec — reviewer-quality and reviewer-security
      // templates declare only {{diff}}, {{rubric}}, and {{knownIssues}}; they have
      // no {{specs}} placeholder so passing the variable is a silent no-op (#438).
      if (sessionType === 'reviewer-spec') {
        variables.specs = specs || 'No spec content available for this review.';
      }
      variables.knownIssues = knowledgeContext || '';

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

        // Parse structured output — with --json-schema, the CLI stores the result
        // in structured_output. Fall back to extracting JSON from the result text
        // (model may follow prompt template and put JSON in a markdown code block
        // instead of using structured output).
        const rawData = result.value.structuredData;
        const so = rawData !== null && typeof rawData === 'object'
          ? (rawData as Record<string, unknown>).structured_output
          : undefined;
        let structuredPayload: unknown;
        if (so !== null && so !== undefined) {
          // Preferred path: --json-schema produced structured_output
          structuredPayload = so;
        } else {
          // Fallback: model followed prompt code block format and put JSON in result text.
          // structured_output is null when the model produces markdown code block output
          // instead of using the CLI's structured output mechanism.
          const resultText = typeof (rawData as Record<string, unknown>)?.result === 'string'
            ? (rawData as Record<string, unknown>).result as string
            : result.value.output;
          const jsonMatch = resultText.match(/```json\s*([\s\S]*?)```/s) ?? resultText.match(/(\{[\s\S]*\})/s);
          if (jsonMatch?.[1]) {
            try { structuredPayload = JSON.parse(jsonMatch[1]); } catch { structuredPayload = rawData; }
          } else {
            structuredPayload = rawData;
          }
        }
        // Normalize severity values: model sometimes uses non-standard terms
        // (e.g. "moderate" instead of "important", "high" instead of "critical").
        const normalizedPayload = normalizeSeverities(structuredPayload);
        const parsed = ReviewFindingsSchema.safeParse(normalizedPayload);
        if (!parsed.success) {
          const subtype = (rawData as Record<string, unknown>)?.subtype;
          const parseErr = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
          console.warn(`[reviewer] structured output parse failed (attempt ${attempt + 1}, subtype=${subtype}): ${parseErr}`);
          console.warn(`[reviewer] structured_output value: ${JSON.stringify(structuredPayload)?.slice(0, 500)}`);
          if (attempt === 0) continue; // retry once
          return {
            gate: type,
            passed: false,
            findings: [{ severity: 'critical', location: 'output', description: `Reviewer produced invalid structured output (subtype=${subtype}): ${parseErr}` }],
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
  gateResult: GateResult,
): DiscoveredIssue[] {
  return gateResult.discoveredIssues ?? [];
}
