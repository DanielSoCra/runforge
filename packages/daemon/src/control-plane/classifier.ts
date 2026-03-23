import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { ClassificationSchema, classificationJsonSchema, type ClassificationResult } from './classifier-schema.js';

export interface ClassifyResult {
  event: 'success' | 'success:simple';
  complexity?: ClassificationResult['complexity'];
}

/**
 * Spawns a classifier session to assess work request complexity.
 * Returns the PhaseEvent and the raw complexity for RunState storage.
 */
export async function classify(
  runtime: SessionRuntime,
  workRequest: WorkRequest,
  runWriter?: SupabaseRunWriter,
  runId?: string,
  workspacePath?: string,
  activePlugins?: Array<{ id: string; activatedAt: string }>,
): Promise<ClassifyResult> {
  const context = {
    variables: {
      workRequest: `#${workRequest.issueNumber}: ${workRequest.title}\n\n${workRequest.body}`,
      specRefs: workRequest.specRefs.join(', ') || 'none',
      scope: workRequest.scopeDescription ?? 'no scope description provided',
    },
    workspacePath,
    activePlugins,
  };

  const result = await runtime.spawnSession('classifier', context, workRequest.issueNumber, {
    jsonSchema: classificationJsonSchema,
  }, runWriter, runId);

  if (!result.ok) {
    console.warn(`[classify] Classifier session failed: ${result.error.message} — falling back to simple`);
    return { event: 'success:simple' };
  }

  const parsed = ClassificationSchema.safeParse(result.value.structuredData);
  if (!parsed.success) {
    // No retry here (unlike diagnostician): classification failure falls back to 'simple',
    // which is a safe conservative default. Diagnosis failure routes to human, so retry is
    // worth the cost there. Here, under-classification adds review time but doesn't lose work.
    console.warn(`[classify] Invalid classifier output: ${parsed.error.message} — falling back to simple`);
    return { event: 'success:simple' };
  }

  const { complexity, reasoning } = parsed.data;
  console.log(`[classify] Classification: ${complexity} — ${reasoning}`);

  return {
    event: complexity === 'simple' ? 'success:simple' : 'success',
    complexity,
  };
}
