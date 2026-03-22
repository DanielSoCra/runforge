// src/implementation/context.ts

export interface WorkerContextInput {
  l1Content: string;
  l2Content: string;
  l3Content: string;
  unitContext: string;
  verificationCommand: string;
  pitfalls?: string;
}

export interface CoordinatorContextInput {
  l1Content: string;
  l2Content: string;
  l3Content: string;
  workRequest: string;
  traceabilityMap: string;
}

/**
 * Assemble worker context with spec content in implementation order: L3 → L2 → L1.
 * Workers see actionable patterns first, then architecture, then business context.
 */
export function assembleWorkerContext(input: WorkerContextInput): string {
  const sections: string[] = [
    '## Spec Content (Implementation Order)\n',
    '### Patterns (L3)\n',
    input.l3Content,
    '\n### Architecture (L2)\n',
    input.l2Content,
    '\n### Business Context (L1)\n',
    input.l1Content,
    '\n## Task\n',
    input.unitContext,
    '\n## Verification\n',
    input.verificationCommand,
  ];

  if (input.pitfalls) {
    sections.push('\n## Pitfalls\n', input.pitfalls);
  }

  return sections.join('\n');
}

/**
 * Assemble coordinator context with spec content in understanding order: L1 → L2 → L3.
 * The coordinator needs to understand scope before seeing implementation details.
 */
export function assembleCoordinatorContext(input: CoordinatorContextInput): string {
  return [
    '## Spec Content (Understanding Order)\n',
    '### Business Context (L1)\n',
    input.l1Content,
    '\n### Architecture (L2)\n',
    input.l2Content,
    '\n### Patterns (L3)\n',
    input.l3Content,
    '\n## Work Request\n',
    input.workRequest,
    '\n## Traceability Map\n',
    input.traceabilityMap,
  ].join('\n');
}
