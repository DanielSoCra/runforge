import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { BugDiagnosis, SessionResult } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { BugDiagnosisSchema, bugDiagnosisJsonSchema } from './schema.js';
import { ok, err, type Result } from '../lib/result.js';

/**
 * Extract the structured output payload from a CLI session result.
 * The CLI adapter sets structuredData to the full JSON response object
 * ({result, cost_usd, structured_output}). The actual schema-validated
 * payload lives in the nested structured_output field.
 * Falls back to parsing JSON from the result text when structured_output
 * is null (model used markdown code block instead of structured output).
 */
function extractStructuredOutput(session: SessionResult): unknown {
  const rawData = session.structuredData;
  const so = rawData !== null && typeof rawData === 'object'
    ? (rawData as Record<string, unknown>).structured_output
    : undefined;
  if (so !== null && so !== undefined) {
    return so;
  }
  const resultText = typeof (rawData as Record<string, unknown>)?.result === 'string'
    ? (rawData as Record<string, unknown>).result as string
    : session.output;
  const jsonMatch = resultText.match(/```json\s*([\s\S]*?)```/s) ?? resultText.match(/(\{[\s\S]*\})/s);
  if (jsonMatch?.[1]) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* fall through */ }
  }
  return rawData;
}

export async function diagnose(
  runtime: SessionRuntime,
  issueNumber: number,
  bugReport: string,
  implementationContent: string,
  specContent: string,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  workspacePath?: string,
  activePlugins?: Array<{ id: string; activatedAt: string }>,
): Promise<Result<BugDiagnosis>> {
  const context = {
    variables: {
      bugReport,
      implementation: implementationContent,
      specs: specContent,
    },
    workspacePath,
    activePlugins,
  };

  // First attempt
  const result = await runtime.spawnSession('diagnostician', context, issueNumber, {
    jsonSchema: bugDiagnosisJsonSchema,
  }, runWriter, runId);

  if (!result.ok) return result;

  const parsed = BugDiagnosisSchema.safeParse(extractStructuredOutput(result.value));
  if (parsed.success) return ok(parsed.data);

  // Retry once on invalid output
  const retry = await runtime.spawnSession('diagnostician', context, issueNumber, {
    jsonSchema: bugDiagnosisJsonSchema,
  }, runWriter, runId);

  if (!retry.ok) return retry;

  const retryParsed = BugDiagnosisSchema.safeParse(extractStructuredOutput(retry.value));
  if (retryParsed.success) return ok(retryParsed.data);

  return err(new Error(`Diagnosis produced invalid output after retry: ${retryParsed.error.message}`));
}
