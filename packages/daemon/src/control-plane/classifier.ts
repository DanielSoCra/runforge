import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import type { PhaseEvent } from '../types.js';
import { ClassificationSchema, classificationJsonSchema } from './classifier-schema.js';

/**
 * Spawns a classifier session to assess work request complexity.
 * Returns the appropriate PhaseEvent: 'success:simple' for simple requests,
 * 'success' for standard/complex (which proceeds to decompose).
 */
export async function classify(
  runtime: SessionRuntime,
  workRequest: WorkRequest,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  workspacePath?: string,
): Promise<PhaseEvent> {
  const context = {
    variables: {
      workRequest: `#${workRequest.issueNumber}: ${workRequest.title}\n\n${workRequest.body}`,
      specRefs: workRequest.specRefs.join(', ') || 'none',
      scope: workRequest.scopeDescription ?? 'no scope description provided',
    },
    workspacePath,
  };

  const result = await runtime.spawnSession('classifier', context, workRequest.issueNumber, {
    jsonSchema: classificationJsonSchema,
  }, runWriter, runId);

  if (!result.ok) {
    console.warn(`[classify] Classifier session failed: ${result.error.message} — falling back to simple`);
    return 'success:simple';
  }

  const parsed = ClassificationSchema.safeParse(result.value.structuredData);
  if (!parsed.success) {
    console.warn(`[classify] Invalid classifier output: ${parsed.error.message} — falling back to simple`);
    return 'success:simple';
  }

  const { complexity, reasoning } = parsed.data;
  console.log(`[classify] Classification: ${complexity} — ${reasoning}`);

  return complexity === 'simple' ? 'success:simple' : 'success';
}
