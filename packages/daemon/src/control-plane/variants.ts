import type { PipelineVariant, WorkRequest } from '../types.js';
import { isSpecDrivenRequest } from './spec-pipeline/variant.js';

/**
 * Select the pipeline variant for a work request based on its labels.
 * Checked in priority order — first match wins.
 */
export function selectVariant(request: WorkRequest): PipelineVariant {
  if (isSpecDrivenRequest(request)) return 'spec-driven';
  const labels = new Set(request.labels);
  if (labels.has('website-init')) return 'website';
  if (labels.has('bug')) return 'bug';
  return 'feature-simple';
}
