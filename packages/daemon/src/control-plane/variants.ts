import type { PipelineVariant, WorkRequest } from '../types.js';
import { isSpecDrivenRequest } from './spec-pipeline/variant.js';
import type { FeaturePipelineWorkType } from './work-detection.js';

/** Work types that route directly to the spec-driven pipeline variant. */
const SPEC_DRIVEN_WORK_TYPES: ReadonlySet<string> = new Set<FeaturePipelineWorkType>([
  'l2-brainstorm', 'l3-generate', 'implementation',
]);

/**
 * Select the pipeline variant for a work request based on its work type and labels.
 * Checked in priority order — first match wins.
 */
export function selectVariant(request: WorkRequest): PipelineVariant {
  if (request.workType && SPEC_DRIVEN_WORK_TYPES.has(request.workType)) return 'spec-driven';
  if (isSpecDrivenRequest(request)) return 'spec-driven';
  if (request.workType === 'bug-fix') return 'bug';
  const labels = new Set(request.labels);
  if (labels.has('website-init')) return 'website';
  if (labels.has('bug')) return 'bug';
  return 'feature-simple';
}
