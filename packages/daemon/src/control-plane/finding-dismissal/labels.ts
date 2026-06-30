/**
 * finding-dismissal/labels.ts — the SHARED, STRICT label parser for the
 * finding-dismissal decision flow (PR1). ONE parse, used by three call sites:
 *   - the EMIT trigger (which findings reach the Operator),
 *   - the apply-CONSUMER (verdict labels + audit), and
 *   - the rung-1 learning-key DERIVATION (`decision-api.ts:deriveLearningKey`).
 *
 * Everything here is pure (string in, string/enum out) so it runs identically in
 * the daemon tick, the consumer, and a unit test — no GitHub, no clock, no I/O.
 *
 * The review `category` is the load-bearing signal (it goes INTO the decision
 * class `finding_dismissal:<category>`, so the existing whole-class guard can
 * guard a category). The parser is STRICT over the fixed review-category set
 * (`review-scheduler.ts`): exactly one of the five → that category; zero, an
 * unknown label, or MORE than one (ambiguous) → `null` (no-emit, never train an
 * `uncategorized` class).
 */
import type { ReviewCategory } from '../../coordination/review-scheduler.js';
import { RISK_CLASSES, type RiskClass } from '@auto-claude/decision-protocol';

/**
 * The fixed review-category set. Kept in lockstep with `ReviewCategory`
 * (review-scheduler.ts) by the compile-time `satisfies` check below — adding a
 * category there without adding it here is a type error.
 */
export const REVIEW_CATEGORIES = [
  'correctness',
  'consistency',
  'security',
  'performance',
  'test-gaps',
] as const satisfies readonly ReviewCategory[];

const CATEGORY_SET: ReadonlySet<string> = new Set(REVIEW_CATEGORIES);

/** Type guard: is `s` one of the five fixed review categories? */
export function isReviewCategory(s: string): s is ReviewCategory {
  return CATEGORY_SET.has(s);
}

/**
 * parseCategory — STRICT extraction of the single review category from an
 * issue's labels. Returns the category ONLY when EXACTLY one of the fixed set is
 * present; `null` when absent, unknown, or ambiguous (>1). Absent/ambiguous →
 * no-emit (never train an `uncategorized` class).
 */
export function parseCategory(labels: readonly string[]): ReviewCategory | null {
  let found: ReviewCategory | null = null;
  for (const label of labels) {
    if (isReviewCategory(label)) {
      if (found !== null && found !== label) return null; // ambiguous → null
      found = label;
    }
  }
  return found;
}

/** The human-route label: an Operator explicitly flagged the finding for discussion. */
export const HUMAN_ROUTE_LABEL = 'needs-discussion';

/** Whether the issue carries the human-route (`needs-discussion`) label. */
export function hasHumanRoute(labels: readonly string[]): boolean {
  return labels.includes(HUMAN_ROUTE_LABEL);
}

/**
 * Guarded finding categories (PR1 foundation). The actual cap lives in
 * operator-learning's `DEFAULT_GUARDED_CLASSES` (`finding_dismissal:security`);
 * this mirror lets the emit/consumer reason about a category's guard status
 * without importing the learning engine. Security is guarded by default.
 */
export const GUARDED_FINDING_CATEGORIES: ReadonlySet<ReviewCategory> = new Set<ReviewCategory>([
  'security',
]);

/** Whether a category is guarded (never pre-filled / asked-less — PR2/PR3). */
export function isGuardedFindingCategory(category: ReviewCategory): boolean {
  return GUARDED_FINDING_CATEGORIES.has(category);
}

/** The learning-class string for a finding category — the SAME key observe + derive use. */
export function findingDismissalClass(category: ReviewCategory): string {
  return `finding_dismissal:${category}`;
}

// ── verdict labels (the apply-consumer's terminal markers) ────────────────────

/** Applied when the Operator KEEPS the finding (answer `approve`). */
export const KEPT_LABEL = 'kept';
/** Applied when the Operator DISMISSES the finding (answer `reject`). */
export const DISMISSED_LABEL = 'dismissed';

/** Map the binary answer choice → its verdict label (keep → kept / dismiss → dismissed). */
export function verdictLabelFor(choice: 'approve' | 'reject'): typeof KEPT_LABEL | typeof DISMISSED_LABEL {
  return choice === 'approve' ? KEPT_LABEL : DISMISSED_LABEL;
}

// ── severity → risk_class ─────────────────────────────────────────────────────

/** The fallback risk class when a finding carries no `P0..P3` severity label. */
export const DEFAULT_FINDING_RISK_CLASS: RiskClass = 'P2';

const RISK_CLASS_SET: ReadonlySet<string> = new Set(RISK_CLASSES);

/**
 * parseSeverityRiskClass — derive `risk_class` from the finding's severity label
 * (`P0`..`P3`, the tech-lead-triage convention `/^P\d$/`). The FIRST recognized
 * severity label wins; absent → the cautious default `P2`.
 */
export function parseSeverityRiskClass(labels: readonly string[]): RiskClass {
  for (const label of labels) {
    if (RISK_CLASS_SET.has(label)) return label as RiskClass;
  }
  return DEFAULT_FINDING_RISK_CLASS;
}
