// packages/daemon/src/control-plane/merge-decision/compliance.ts
//
// The merge-decision COMPLIANCE LENS composition. FUNC-AC-MERGE-DECISION: a
// compliance-forced change "composes with and overrides" the merge decision — no
// risk level or lane can earn it an autonomous proceed. This computes the boolean
// `complianceForced` that decideMerge consumes (rule 2, above autonomy).
//
// Where a CHANGE-SCOPED verdict is available, the full compliance evaluator
// (FUNC-AC-COMPLIANCE-GATE) is used and any non-proceed status (hold/blocked)
// forces escalation. When no verdict is available, it falls back to path
// matching: a reviewer's `condition` is interpreted as a PATH GLOB matched (via
// the lane-engine matcher) against the change's touched paths, and any match
// forces the change to the Operator.
// Fail-safe by construction — a match can only ADD caution (force escalation).
//
// SECURITY (#779): the `verdicts` arg must be CHANGE-SCOPED (a verdict on THIS
// change). The integrate caller deliberately passes NO verdicts today, because
// the only verdicts on record are the deployment-scoped `complianceVerdicts` on
// the frozen profile — a static `pass` there must NEVER clear a per-change gate
// (a single historic pass would otherwise auto-merge every future regulated
// change). So a regulated change fails closed (escalates) via path matching.
//
// SCOPE: this is the lens *composition* into the merge decision plus the
// evaluator call. The reviewer DISPATCH (who reviews, when durable PER-CHANGE
// verdicts are recorded) is the remainder of FUNC-AC-COMPLIANCE-GATE, not this
// module's — and is what will legitimately supply the `verdicts` arg.

import { matchesAny } from '../lane-engine/match.js';
import type { ComplianceReviewer } from '../deployment-registry/types.js';
import { evaluateCompliance } from '../../compliance/evaluator.js';
import type { ComplianceReviewVerdict } from '../../compliance/schemas.js';

/**
 * Whether the deployment's compliance lens forces this change to the Operator.
 * Uses the full compliance evaluator when CHANGE-SCOPED verdicts are supplied (a
 * recorded `pass` from every required reviewer can earn a `proceed` that clears
 * the force); otherwise falls back to path-condition matching, where any governed
 * touched path forces escalation. Callers MUST NOT pass deployment-scoped static
 * verdicts as `verdicts` (see SECURITY note above) — absent a per-change verdict,
 * a regulated change fails closed.
 */
export function evaluateComplianceForced(
  reviewers: readonly ComplianceReviewer[],
  touchedPaths: readonly string[],
  verdicts?: Record<string, ComplianceReviewVerdict>,
): boolean {
  if (verdicts !== undefined && reviewers.length > 0) {
    const profile = {
      regulatedPaths: reviewers.map((r) => ({
        pattern: r.condition,
        requiredReviewers: [r.reviewer],
      })),
    };
    const evaluation = evaluateCompliance({
      profile,
      touchedPaths: touchedPaths as string[],
      verdicts,
    });
    return evaluation.status !== 'proceed';
  }

  return reviewers.some((r) => touchedPaths.some((p) => matchesAny(p, [r.condition])));
}
