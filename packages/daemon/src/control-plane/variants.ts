import type { PipelineVariant, WorkRequest } from '../types.js';
import { isSpecDrivenRequest } from './spec-pipeline/variant.js';

/**
 * Select the pipeline variant for a work request based on its work type and labels.
 * Checked in priority order — first match wins.
 */
export function selectVariant(request: WorkRequest): PipelineVariant {
  if (isSpecDrivenRequest(request)) return 'spec-driven';
  if (request.workType === 'bug-fix') return 'bug';
  const labels = new Set(request.labels);
  if (labels.has('website-init')) return 'website';
  if (labels.has('bug')) return 'bug';
  return 'feature-simple';
}
