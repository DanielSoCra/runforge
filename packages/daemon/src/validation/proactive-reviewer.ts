// src/validation/proactive-reviewer.ts
import { z } from 'zod';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';

export const ProactiveFindingSchema = z.object({
  title: z.string(),
  severity: z.enum(['critical', 'important', 'minor']),
  location: z.string(),
  description: z.string(),
  evidence: z.string(),
});

export type ProactiveFinding = z.infer<typeof ProactiveFindingSchema>;

const ProactiveResultSchema = z.object({
  findings: z.array(ProactiveFindingSchema),
});

const jsonSchema = JSON.stringify(z.toJSONSchema(ProactiveResultSchema));

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

export interface ProactiveReviewInput {
  area: string;
  cwd: string;
  recentCommits: string;
  issueNumber: number;
  runWriter?: SupabaseRunWriter;
  runId?: string;
}

export type ProactiveReviewResult =
  | { ok: true; findings: ProactiveFinding[] }
  | { ok: false; error: string };

/**
 * Spawn a Session Runtime session with an exploratory rubric for proactive
 * codebase review. The session scans broadly for: spec-code drift, dead code,
 * security regression, convention violations, test coverage gaps.
 */
export async function runProactiveReview(
  runtime: SessionRuntime,
  input: ProactiveReviewInput,
): Promise<ProactiveReviewResult> {
  const rubric = [
    'Exploratory codebase review. Scan the given area for:',
    '1. Spec-code drift — implementation diverges from spec patterns',
    '2. Dead code — unused functions, unreachable branches',
    '3. Security regression — new injection risks, missing validation',
    '4. Convention violations — inconsistent naming, import patterns',
    '5. Test coverage gaps — untested edge cases, missing assertions',
  ].join('\n');

  const variables: Record<string, string> = {
    category: input.area,
    maxIssues: '10',
    rubric,
    recentCommits: input.recentCommits,
  };

  const result = await runtime.spawnSession(
    'codebase-reviewer',
    { variables, workspacePath: input.cwd },
    input.issueNumber,
    { jsonSchema },
    input.runWriter,
    input.runId,
  );

  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }

  // Unwrap the CLI wrapper {result, cost_usd, structured_output} to get the payload.
  // Peer callers (reviewer-session.ts:111-117) use the same pattern.
  const rawData = result.value.structuredData;
  const so =
    rawData !== null && typeof rawData === 'object'
      ? (rawData as Record<string, unknown>).structured_output
      : undefined;
  let structuredPayload: unknown;
  if (so !== null && so !== undefined) {
    structuredPayload = so;
  } else {
    // Fallback: model put JSON in result text as markdown code block
    const resultText =
      typeof (rawData as Record<string, unknown>)?.result === 'string'
        ? ((rawData as Record<string, unknown>).result as string)
        : result.value.output;
    const jsonMatch =
      resultText.match(/```json\s*([\s\S]*?)```/s) ?? resultText.match(/(\{[\s\S]*\})/s);
    if (jsonMatch?.[1]) {
      try {
        structuredPayload = JSON.parse(jsonMatch[1]);
      } catch {
        structuredPayload = rawData;
      }
    } else {
      structuredPayload = rawData;
    }
  }

  const parsed = ProactiveResultSchema.safeParse(normalizeSeverities(structuredPayload));
  if (!parsed.success) {
    return { ok: false, error: `Invalid structured output: ${parsed.error.message}` };
  }

  return { ok: true, findings: parsed.data.findings };
}
