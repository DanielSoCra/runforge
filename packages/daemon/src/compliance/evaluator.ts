// packages/daemon/src/compliance/evaluator.ts
//
// Pure compliance gate evaluator. No I/O; callers pass profile, paths, and verdicts.

import micromatch from 'micromatch';
import {
  ComplianceProfileSchema,
  type ComplianceProfile,
  type ComplianceReviewVerdict,
  type ComplianceEvaluation,
} from './schemas.js';

export interface EvaluateComplianceInput {
  profile: unknown;
  touchedPaths: string[];
  verdicts: Record<string, ComplianceReviewVerdict>;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

type ParseProfileResult =
  | { ok: true; profile: ComplianceProfile }
  | { ok: false; error: string };

function parseProfile(profile: unknown): ParseProfileResult {
  const result = ComplianceProfileSchema.safeParse(profile);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, profile: result.data };
}

/**
 * Fail-closed evaluation returned when the compliance profile is malformed,
 * incomplete, or otherwise unparseable. FUNC-AC-COMPLIANCE-GATE constrains the
 * gate to fail closed on "any uncertainty — unknown verdict, unavailable
 * reviewer, unrecognized path, incomplete configuration": the change is held for
 * a human (blocked/escalate), NEVER silently released. A profile we cannot
 * validate is exactly such an uncertainty, so it must BLOCK rather than degrade
 * to an empty "proceed".
 */
function malformedProfileEvaluation(error: string): ComplianceEvaluation {
  return {
    status: 'blocked',
    matchedPaths: [],
    requiredReviewers: [],
    verdicts: {},
    missingReviewers: [],
    blockingReviewers: [],
    reasons: [
      `invalid or incomplete compliance profile — failing closed (escalate): ${error}`,
    ],
  };
}

function matchRegulatedPaths(
  profile: ComplianceProfile,
  touchedPaths: string[],
): { matchedPaths: string[]; requiredReviewers: Set<string> } {
  const matchedPaths: string[] = [];
  const requiredReviewers = new Set<string>();

  for (const path of touchedPaths) {
    const normalized = normalizePath(path);
    for (const regulated of profile.regulatedPaths) {
      if (micromatch.isMatch(normalized, regulated.pattern, { dot: true })) {
        if (!matchedPaths.includes(normalized)) {
          matchedPaths.push(normalized);
        }
        for (const reviewer of regulated.requiredReviewers) {
          requiredReviewers.add(reviewer);
        }
      }
    }
  }

  return { matchedPaths, requiredReviewers };
}

export function evaluateCompliance(
  input: EvaluateComplianceInput,
): ComplianceEvaluation {
  const parsed = parseProfile(input.profile);
  if (!parsed.ok) {
    // Fail-closed: a malformed/incomplete profile holds the change for a human.
    console.warn(
      `[compliance] invalid compliance profile (failing closed): ${parsed.error}`,
    );
    return malformedProfileEvaluation(parsed.error);
  }
  const profile = parsed.profile;
  const touchedPaths = input.touchedPaths
    .map((p) => normalizePath(p))
    .filter((p, i, arr) => arr.indexOf(p) === i);

  const { matchedPaths, requiredReviewers } = matchRegulatedPaths(
    profile,
    touchedPaths,
  );

  if (requiredReviewers.size === 0) {
    return {
      status: 'proceed',
      matchedPaths,
      requiredReviewers: [],
      verdicts: {},
      missingReviewers: [],
      blockingReviewers: [],
      reasons: ['no regulated-sensitive paths touched'],
    };
  }

  const requiredReviewerArray = Array.from(requiredReviewers).sort();
  const blockingReviewers: string[] = [];
  const missingReviewers: string[] = [];
  const presentVerdicts: Record<string, ComplianceReviewVerdict> = {};

  for (const reviewer of requiredReviewerArray) {
    const verdict = input.verdicts[reviewer];
    if (verdict === undefined) {
      missingReviewers.push(reviewer);
      continue;
    }
    presentVerdicts[reviewer] = verdict;
    if (verdict.verdict === 'block') {
      blockingReviewers.push(reviewer);
    }
  }

  const reasons: string[] = [];
  if (blockingReviewers.length > 0) {
    reasons.push(
      `blocking verdicts from: ${blockingReviewers.join(', ')}`,
    );
  }
  if (missingReviewers.length > 0) {
    reasons.push(
      `missing or incomplete reviews from: ${missingReviewers.join(', ')}`,
    );
  }

  if (blockingReviewers.length > 0) {
    return {
      status: 'blocked',
      matchedPaths,
      requiredReviewers: requiredReviewerArray,
      verdicts: presentVerdicts,
      missingReviewers,
      blockingReviewers,
      reasons,
    };
  }

  if (missingReviewers.length > 0) {
    return {
      status: 'hold',
      matchedPaths,
      requiredReviewers: requiredReviewerArray,
      verdicts: presentVerdicts,
      missingReviewers,
      blockingReviewers,
      reasons,
    };
  }

  return {
    status: 'proceed',
    matchedPaths,
    requiredReviewers: requiredReviewerArray,
    verdicts: presentVerdicts,
    missingReviewers: [],
    blockingReviewers: [],
    reasons: ['all required compliance reviews passed'],
  };
}
