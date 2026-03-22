// gate.ts — Gate evaluation logic for spec-driven pipeline
// Governed by: STACK-AC-SPEC-PIPELINE

/**
 * Comment from GitHub issue or PR review — used to extract feedback.
 */
export interface GateComment {
  body: string;
  createdAt: string;
}

/**
 * Discriminated union for gate evaluation outcomes.
 *   approved  — forward transition
 *   feedback  — backward transition with extracted feedback content
 *   unchanged — remain parked (no cost incurred)
 */
export type GateOutcome =
  | { status: 'approved' }
  | { status: 'feedback'; content: string }
  | { status: 'unchanged' };

/**
 * Maps each spec phase to its GitHub label names.
 * Keeps label strings in one place — gate evaluation and label-writing
 * both reference this map.
 */
export const SPEC_LABEL_MAP: Record<
  'l2-design' | 'l2-gate' | 'l3-generate' | 'l3-compliance' | 'detect' | 'implement' | 'review' | 'holdout' | 'integrate' | 'report',
  { inProgress: string; approval?: string; feedback?: string }
> = {
  detect: { inProgress: 'implementing' },
  'l2-design': { inProgress: 'l2-in-progress' },
  'l2-gate': { inProgress: 'l2-review', approval: 'l2-approved', feedback: 'l2-in-progress' },
  'l3-generate': { inProgress: 'l3-in-progress' },
  'l3-compliance': { inProgress: 'l3-review' },
  implement: { inProgress: 'implementing' },
  review: { inProgress: 'implementing' },
  holdout: { inProgress: 'implementing' },
  integrate: { inProgress: 'implementing' },
  report: { inProgress: 'implementing' },
} as const;

/**
 * Pure gate evaluation function.
 *
 * Checks if labels contain the approval or feedback condition.
 * For feedback: requires at least one comment since the last gate event
 * to avoid empty feedback loops (L3 gotcha: `since` is inclusive).
 *
 * @param labels - Current labels on the work request
 * @param commentsSince - Comments posted since the last gate event
 * @param approvalLabel - Label that means "approved"
 * @param feedbackLabel - Label that means "feedback / revise"
 */
export function evaluateGate(
  labels: string[],
  commentsSince: GateComment[],
  approvalLabel: string,
  feedbackLabel: string,
): GateOutcome {
  if (labels.includes(approvalLabel)) {
    return { status: 'approved' };
  }
  if (labels.includes(feedbackLabel) && commentsSince.length > 0) {
    const content = commentsSince.map(c => c.body).join('\n---\n');
    return { status: 'feedback', content };
  }
  return { status: 'unchanged' };
}
