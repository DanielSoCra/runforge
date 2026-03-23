import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { WorkRequest } from '../types.js';
import type { SupabaseRunWriter } from '../supabase/run-writer.js';
import { SessionError } from '../session-runtime/session-error.js';
import { ClassificationSchema, classificationJsonSchema, type ClassificationResult } from './classifier-schema.js';

export interface ClassifyResult {
  event: 'success' | 'success:simple' | 'budget-exceeded' | 'rate-limited' | 'containment-breach';
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
    // Extract safety signals from SessionError before falling back (ARCH-AC-OPERATIONAL-SAFETY)
    if (result.error instanceof SessionError) {
      if (result.error.rateLimited) {
        console.warn(`[classify] Classifier session rate-limited: ${result.error.message} — signaling pipeline to pause`);
        return { event: 'rate-limited' };
      }
      if (result.error.containmentBreach) {
        console.warn(`[classify] Classifier session containment breach: ${result.error.message} — signaling pipeline`);
        return { event: 'containment-breach' };
      }
      // SessionError.budgetExceeded() has cost=0, rateLimited=false, containmentBreach=false —
      // no dedicated boolean, so detect via message prefix (matches factory method format)
      if (result.error.message.startsWith('Budget exceeded')) {
        console.warn(`[classify] Classifier session budget exceeded: ${result.error.message} — signaling pipeline to pause`);
        return { event: 'budget-exceeded' };
      }
    }
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
