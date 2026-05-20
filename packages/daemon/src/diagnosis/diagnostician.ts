import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { BugDiagnosis, SessionResult } from '../types.js';
import type { RunWriter } from '../data/run-writer.js';
import { BugDiagnosisSchema, bugDiagnosisJsonSchema } from './schema.js';
import { ok, err, type Result } from '../lib/result.js';
import { extractStructuredOutput as unwrapStructuredOutput } from '../lib/structured-output.js';

/**
 * Extract the structured output payload from a CLI session result.
 * The CLI adapter sets structuredData to the full JSON response object
 * ({result, cost_usd, structured_output}). The actual schema-validated
 * payload lives in the nested structured_output field.
 * Falls back to parsing JSON from the result text when structured_output
 * is null (model used markdown code block instead of structured output).
 */
function extractStructuredOutput(session: SessionResult): unknown {
  const so = unwrapStructuredOutput(session.structuredData);
  if (so !== session.structuredData) return so;
  // Fallback: model used markdown code block instead of structured output
  const rd = session.structuredData as Record<string, unknown> | null;
  const resultText =
    typeof rd?.['result'] === 'string'
      ? (rd['result'] as string)
      : session.output;
  const jsonMatch =
    resultText.match(/```json\s*([\s\S]*?)```/s) ??
    resultText.match(/(\{[\s\S]*\})/s);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      /* fall through */
    }
  }
  return session.structuredData;
}

export async function diagnose(
  runtime: SessionRuntime,
  issueNumber: number,
  bugReport: string,
  implementationContent: string,
  specContent: string,
  runWriter?: RunWriter,
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
  const result = await runtime.spawnSession(
    'diagnostician',
    context,
    issueNumber,
    {
      jsonSchema: bugDiagnosisJsonSchema,
    },
    runWriter,
    runId,
  );

  if (!result.ok) return result;

  const parsed = BugDiagnosisSchema.safeParse(
    extractStructuredOutput(result.value),
  );
  if (parsed.success) return ok(parsed.data);

  // Retry once on invalid output
  const retry = await runtime.spawnSession(
    'diagnostician',
    context,
    issueNumber,
    {
      jsonSchema: bugDiagnosisJsonSchema,
    },
    runWriter,
    runId,
  );

  if (!retry.ok) return retry;

  const retryParsed = BugDiagnosisSchema.safeParse(
    extractStructuredOutput(retry.value),
  );
  if (retryParsed.success) return ok(retryParsed.data);

  return err(
    new Error(
      `Diagnosis produced invalid output after retry: ${retryParsed.error.message}`,
    ),
  );
}
