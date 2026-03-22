import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { BugDiagnosis } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { BugDiagnosisSchema, bugDiagnosisJsonSchema } from './schema.js';
import { ok, err, type Result } from '../lib/result.js';

export async function diagnose(
  runtime: SessionRuntime,
  issueNumber: number,
  bugReport: string,
  implementationContent: string,
  specContent: string,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  workspacePath?: string,
): Promise<Result<BugDiagnosis>> {
  const context = {
    variables: {
      bugReport,
      implementation: implementationContent,
      specs: specContent,
    },
    workspacePath,
  };

  // First attempt
  const result = await runtime.spawnSession('diagnostician', context, issueNumber, {
    jsonSchema: bugDiagnosisJsonSchema,
  }, runWriter, runId);

  if (!result.ok) return result;

  const parsed = BugDiagnosisSchema.safeParse(result.value.structuredData);
  if (parsed.success) return ok(parsed.data);

  // Retry once on invalid output
  const retry = await runtime.spawnSession('diagnostician', context, issueNumber, {
    jsonSchema: bugDiagnosisJsonSchema,
  }, runWriter, runId);

  if (!retry.ok) return retry;

  const retryParsed = BugDiagnosisSchema.safeParse(retry.value.structuredData);
  if (retryParsed.success) return ok(retryParsed.data);

  return err(new Error(`Diagnosis produced invalid output after retry: ${retryParsed.error.message}`));
}
