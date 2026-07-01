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

// ── PR3-pre: fail-closed protection / routine classifiers ─────────────────────
//
// These are the SINGLE fail-closed gate the rung-2 pre-fill (and, later, the
// rung-4 auto-dismiss) consult before ever recommending/applying a dismiss on a
// finding. "Fail closed" = ANY uncertainty (a guarded category, an explicit
// protection label, a human-route flag, or an uncertain/critical severity)
// resolves to "protected" → the Operator is asked, never pre-filled/auto-acted.

/**
 * Explicit protection labels — an Operator (or an upstream policy) marked the
 * finding as one that must always reach a human. ANY of these on a finding forces
 * asking (never pre-filled, never auto-dismissed), regardless of category/severity.
 */
export const PROTECTION_LABELS: ReadonlySet<string> = new Set<string>([
  'compliance',
  'sensitive',
  'sensitive-data',
  'release',
  'production-release',
  'safety-critical',
  'spec-content',
]);

/**
 * The routine vocabulary — the ONLY labels a *routine* finding may carry:
 * `review-finding` + the five review categories + the `P0..P3` risk classes +
 * the human-route label. Any label OUTSIDE this set makes the finding NOVEL
 * (→ ask, never auto-handle — codex CRIT-3).
 */
export const ROUTINE_VOCABULARY: ReadonlySet<string> = new Set<string>([
  'review-finding',
  ...REVIEW_CATEGORIES,
  ...RISK_CLASSES,
  HUMAN_ROUTE_LABEL,
]);

/**
 * explicitSeverity — the finding's severity risk class ONLY when EXACTLY one
 * `P0..P3` label is present; `null` when the severity is uncertain (MISSING or
 * MULTIPLE labels). Unlike `parseSeverityRiskClass` (which defaults to `P2` — a
 * fail-OPEN convenience for the emit request), this is FAIL-CLOSED: uncertainty
 * yields `null` so a pre-fill/auto-act caller must ask rather than assume.
 */
export function explicitSeverity(labels: readonly string[]): RiskClass | null {
  let found: RiskClass | null = null;
  let count = 0;
  for (const label of labels) {
    if (RISK_CLASS_SET.has(label)) {
      found = label as RiskClass;
      count += 1;
    }
  }
  return count === 1 ? found : null;
}

/**
 * isProtectedFinding — the central fail-closed classifier (codex CRIT-2). A
 * finding is PROTECTED (must be asked, never pre-filled/auto-dismissed) if ANY:
 *   - its category is guarded (`security`);
 *   - it carries the human-route label (`needs-discussion`);
 *   - it carries any explicit protection label (`PROTECTION_LABELS`);
 *   - its severity is UNCERTAIN (`explicitSeverity` is `null` — missing/ambiguous)
 *     or CRITICAL (`P0`).
 */
export function isProtectedFinding(labels: readonly string[]): boolean {
  const category = parseCategory(labels);
  if (category !== null && isGuardedFindingCategory(category)) return true;
  if (hasHumanRoute(labels)) return true;
  if (labels.some((l) => PROTECTION_LABELS.has(l))) return true;
  const severity = explicitSeverity(labels);
  return severity === null || severity === 'P0';
}

/**
 * isRoutineFinding — the finding's label set is a subset of the routine
 * vocabulary. ANY unrecognized label → NOT routine (novel → ask). Note this is
 * orthogonal to `isProtectedFinding`: a routine finding can still be protected
 * (e.g. `needs-discussion`/`security`/`P0` are all in the vocabulary), so an
 * auto-act path must pass BOTH `isRoutineFinding` AND `!isProtectedFinding`.
 */
export function isRoutineFinding(labels: readonly string[]): boolean {
  return labels.every((l) => ROUTINE_VOCABULARY.has(l));
}
