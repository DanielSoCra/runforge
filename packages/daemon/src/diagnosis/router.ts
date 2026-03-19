import type { BugDiagnosis } from '../types.js';

export type RoutingDecision =
  | { route: 'bug-pipeline'; diagnosis: BugDiagnosis }
  | { route: 'needs-spec-update'; diagnosis: BugDiagnosis }
  | { route: 'needs-human'; diagnosis: BugDiagnosis; reason: string };

export function routeDiagnosis(
  diagnosis: BugDiagnosis,
  confidenceThreshold: number = 0.7,
): RoutingDecision {
  if (diagnosis.confidence < confidenceThreshold) {
    return { route: 'needs-human', diagnosis, reason: `Low confidence: ${diagnosis.confidence}` };
  }
  if (diagnosis.type === 'A') {
    return { route: 'bug-pipeline', diagnosis };
  }
  if (diagnosis.type === 'B') {
    return { route: 'needs-spec-update', diagnosis };
  }
  return { route: 'needs-human', diagnosis, reason: 'Type C: expectation mismatch' };
}
