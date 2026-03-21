import type { PipelineVariant, WorkRequest } from '../types.js';

/**
 * Select the pipeline variant for a work request based on its labels.
 * Checked in priority order — first match wins.
 */
export function selectVariant(request: WorkRequest): PipelineVariant {
  const labels = new Set(request.labels);
  if (labels.has('website-init')) return 'website';
  if (labels.has('bug')) return 'bug';
  return 'feature-simple';
}
