// packages/daemon/src/operator-learning/preference-engine.ts
//
// Pure preference derivation and rung state machine.

import {
  type Observation,
  type DecisionAnswerObservation,
  type Preference,
  type Rung,
  type RungThresholds,
  type EvidenceSummary,
  DEFAULT_RUNG_THRESHOLDS,
} from './types.js';

export type RungResult =
  | { ok: true; rung: Rung }
  | { ok: false; reason: string };

export function countByChoice(
  observations: DecisionAnswerObservation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    const choice = obs.chosenOption;
    counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }
  return counts;
}

export function deriveEvidenceSummary(
  observations: Observation[],
): EvidenceSummary {
  const rawAnswers = observations.filter(
    (o): o is DecisionAnswerObservation => o.kind === 'decision_answer',
  );

  // Deduplicate by sourceDecisionId. A daemon retry can re-emit the same
  // decision-answer observation; counting it more than once would inflate
  // matchingChoices/totalObservations and push confidence past rung thresholds.
  // Each operator decision (sourceDecisionId) must contribute exactly once.
  const bySource = new Map<string, DecisionAnswerObservation>();
  for (const o of rawAnswers) {
    bySource.set(o.sourceDecisionId, o); // last write wins
  }
  const decisionAnswers = [...bySource.values()];

  const counts = countByChoice(decisionAnswers);
  let mostFrequentChoice: string | undefined;
  let maxCount = 0;
  for (const [choice, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostFrequentChoice = choice;
    }
  }

  const matchingChoices = mostFrequentChoice !== undefined ? maxCount : 0;
  const contradictingChoices = decisionAnswers.length - matchingChoices;
  const distinctSources = new Set(decisionAnswers.map((o) => o.sourceDecisionId)).size;

  return {
    totalObservations: decisionAnswers.length,
    matchingChoices,
    contradictingChoices,
    distinctSources,
    mostFrequentChoice,
  };
}

export function computeConfidence(evidence: EvidenceSummary): number {
  const total = evidence.matchingChoices + evidence.contradictingChoices;
  if (total === 0) return 0;
  // Laplace smoothing
  return (evidence.matchingChoices + 1) / (total + 2);
}

/**
 * Whether the evidence is strong enough to *propose* asking less (i.e. crosses
 * the proposeAskLess thresholds). This is the eligibility gate for creating an
 * AskLessProposal — it is NOT the same as the active `propose-ask-less` rung,
 * which additionally requires an approved proposal (see resolveRung).
 */
export function meetsAskLessEvidence(
  evidence: EvidenceSummary,
  thresholds: RungThresholds,
): boolean {
  return (
    evidence.totalObservations >= thresholds.proposeAskLess.minObservations &&
    evidence.distinctSources >= thresholds.proposeAskLess.minDistinctSources &&
    computeConfidence(evidence) >= thresholds.proposeAskLess.minConfidence
  );
}

function meetsPreFillEvidence(
  evidence: EvidenceSummary,
  thresholds: RungThresholds,
): boolean {
  return (
    evidence.totalObservations >= thresholds.preFill.minObservations &&
    evidence.distinctSources >= thresholds.preFill.minDistinctSources &&
    computeConfidence(evidence) >= thresholds.preFill.minConfidence
  );
}

export function resolveRung(
  evidence: EvidenceSummary,
  thresholds: RungThresholds,
  guarded: boolean,
  hasApprovedProposal = false,
): Rung {
  if (guarded) return 'surface';
  // The active `propose-ask-less` rung (we actually ask less) is only reached
  // once an AskLessProposal has been *approved* for this class/context. Until
  // then, even evidence that crosses the proposeAskLess thresholds stays at the
  // `pre-fill` active state — the operator is still asked, just with a default.
  if (meetsAskLessEvidence(evidence, thresholds) && hasApprovedProposal) {
    return 'propose-ask-less';
  }
  if (
    meetsPreFillEvidence(evidence, thresholds) ||
    meetsAskLessEvidence(evidence, thresholds)
  ) {
    return 'pre-fill';
  }
  return 'surface';
}

/**
 * Timestamp of the most recent `preference_reset`/`preference_revert` event for
 * a (class, context). Returns 0 when none exists. Both events return the
 * preference to a cautious, pre-learning state, so this cutoff invalidates
 * everything learned (or approved) before it.
 */
export function lastResetAt(
  observations: Observation[],
  decisionClass: string,
  context: string,
): number {
  let cutoff = 0;
  for (const o of observations) {
    if (
      o.decisionClass === decisionClass &&
      o.context === context &&
      (o.kind === 'preference_reset' || o.kind === 'preference_revert') &&
      o.observedAt > cutoff
    ) {
      cutoff = o.observedAt;
    }
  }
  return cutoff;
}

export function observationsAfterLastReset(
  observations: Observation[],
  decisionClass: string,
  context: string,
): Observation[] {
  const cutoff = lastResetAt(observations, decisionClass, context);
  return observations.filter(
    (o) =>
      o.decisionClass === decisionClass &&
      o.context === context &&
      o.observedAt > cutoff,
  );
}

export function derivePreference(
  decisionClass: string,
  context: string,
  observations: Observation[],
  thresholds: RungThresholds = DEFAULT_RUNG_THRESHOLDS,
  guardedClasses: Set<string> = new Set(),
  hasApprovedProposal = false,
): Preference {
  const relevant = observationsAfterLastReset(observations, decisionClass, context);
  const evidence = deriveEvidenceSummary(relevant);
  const guarded = guardedClasses.has(decisionClass);
  const rung = resolveRung(evidence, thresholds, guarded, hasApprovedProposal);
  const confidence = computeConfidence(evidence);

  const updatedAt = relevant.length > 0
    ? Math.max(...relevant.map((o) => o.observedAt))
    : Date.now();

  return {
    decisionClass,
    context,
    confidence,
    mostFrequentChoice: evidence.mostFrequentChoice,
    rung,
    evidenceSummary: {
      totalObservations: evidence.totalObservations,
      matchingChoices: evidence.matchingChoices,
      contradictingChoices: evidence.contradictingChoices,
      distinctSources: evidence.distinctSources,
    },
    updatedAt,
  };
}

export function advanceRung(
  currentRung: Rung,
  target: Rung,
  decisionClass: string,
  guardedClasses: Set<string>,
): RungResult {
  if (guardedClasses.has(decisionClass) && target !== 'surface') {
    return { ok: false, reason: `guarded class '${decisionClass}' cannot advance past surface` };
  }
  const order: Rung[] = ['surface', 'pre-fill', 'propose-ask-less'];
  const currentIndex = order.indexOf(currentRung);
  const targetIndex = order.indexOf(target);
  if (targetIndex < currentIndex) {
    return { ok: true, rung: target };
  }
  // Only allow single-rung advancement
  if (targetIndex > currentIndex + 1) {
    return { ok: false, reason: 'cannot skip a rung' };
  }
  return { ok: true, rung: target };
}
