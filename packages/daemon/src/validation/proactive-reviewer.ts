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

  const parsed = ProactiveResultSchema.safeParse(result.value.structuredData);
  if (!parsed.success) {
    return { ok: false, error: `Invalid structured output: ${parsed.error.message}` };
  }

  return { ok: true, findings: parsed.data.findings };
}
