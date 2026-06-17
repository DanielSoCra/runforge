// packages/daemon/src/control-plane/merge-decision/compliance.ts
//
// The merge-decision COMPLIANCE LENS composition. FUNC-AC-MERGE-DECISION: a
// compliance-forced change "composes with and overrides" the merge decision — no
// risk level or lane can earn it an autonomous proceed. This computes the boolean
// `complianceForced` that decideMerge consumes (rule 2, above autonomy).
//
// A reviewer's `condition` is interpreted as a PATH GLOB matched (via the
// lane-engine matcher) against the change's touched paths: if any touched path is
// governed by any compliance reviewer, the change is forced to the Operator.
// Fail-safe by construction — a match can only ADD caution (force escalation).
//
// SCOPE: this is only the lens *composition* into the merge decision. The full
// compliance reviewer dispatch + verdict (who reviews, the reviewer's outcome)
// is FUNC-AC-COMPLIANCE-GATE's concern, not this module's.

import { matchesAny } from '../lane-engine/match.js';
import type { ComplianceReviewer } from '../deployment-registry/types.js';

/**
 * Whether the deployment's compliance lens forces this change to the Operator:
 * true iff any touched path matches any compliance reviewer's condition glob.
 */
export function evaluateComplianceForced(
  reviewers: readonly ComplianceReviewer[],
  touchedPaths: readonly string[],
): boolean {
  return reviewers.some((r) => touchedPaths.some((p) => matchesAny(p, [r.condition])));
}
