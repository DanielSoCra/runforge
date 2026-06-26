// packages/daemon/src/operator-learning/ranking.ts
//
// Global inbox ranking and pull-time relevance using learned preferences.

import {
  type Observation,
  type Preference,
  type Rung,
  type RankedItem,
  type RankingExplanation,
  type OperatorLearningConfig,
  type InboxItem,
  DEFAULT_RUNG_THRESHOLDS,
} from './types.js';
import { derivePreference, computeConfidence, deriveEvidenceSummary } from './preference-engine.js';

export type { InboxItem };

export function isGuarded(decisionClass: string, guardedClasses: Set<string>): boolean {
  return guardedClasses.has(decisionClass);
}

export function computeAttentionWeight(
  observations: Observation[],
  decisionClass: string,
  context: string,
  windowMs: number,
  now: number,
): number {
  const cutoff = now - windowMs;
  let weight = 0;
  for (const obs of observations) {
    if (
      obs.kind !== 'rerank_action' ||
      obs.decisionClass !== decisionClass ||
      obs.context !== context ||
      obs.observedAt < cutoff
    ) {
      continue;
    }
    switch (obs.action) {
      case 'pin':
      case 'reorder-to-top':
        weight += 1;
        break;
      case 'mute':
      case 'defer':
        weight -= 1;
        break;
    }
  }
  return weight;
}

export function buildPreferenceMap(
  observations: Observation[],
  items: InboxItem[],
  config: Pick<OperatorLearningConfig, 'thresholds' | 'guardedClasses'>,
  approvedKeys: Set<string> = new Set(),
): Map<string, Preference> {
  const key = (decisionClass: string, context: string) => `${decisionClass}::${context}`;
  const map = new Map<string, Preference>();
  const guarded = new Set(config.guardedClasses);

  const keys = new Set<string>();
  for (const item of items) {
    keys.add(key(item.decisionClass, item.context));
  }

  for (const k of keys) {
    const [decisionClass, context] = k.split('::');
    if (decisionClass === undefined || context === undefined) continue;
    const relevant = observations.filter(
      (o) => o.decisionClass === decisionClass && o.context === context,
    );
    const preference = derivePreference(
      decisionClass,
      context,
      relevant,
      config.thresholds ?? DEFAULT_RUNG_THRESHOLDS,
      guarded,
      approvedKeys.has(k),
    );
    map.set(k, preference);
  }

  return map;
}

export function computeBoost(
  preference: Preference | undefined,
  attentionWeight: number,
  scale: number,
): number {
  if (!preference) return 0;
  const rungBoost: Record<Rung, number> = {
    surface: 0.1,
    'pre-fill': 0.3,
    'propose-ask-less': 0.5,
  };
  return (rungBoost[preference.rung] * preference.confidence + attentionWeight * 0.05) * scale;
}

export function rankItems(
  items: InboxItem[],
  observations: Observation[],
  config: Pick<OperatorLearningConfig, 'thresholds' | 'guardedClasses' | 'attentionWindowMs' | 'rankingBoostScale'>,
  now = Date.now(),
  approvedKeys: Set<string> = new Set(),
): RankedItem[] {
  const thresholds = config.thresholds ?? DEFAULT_RUNG_THRESHOLDS;
  const preferences = buildPreferenceMap(observations, items, { thresholds, guardedClasses: config.guardedClasses }, approvedKeys);

  const ranked = items.map((item) => {
    const key = `${item.decisionClass}::${item.context}`;
    const preference = preferences.get(key);
    const attentionWeight = computeAttentionWeight(
      observations,
      item.decisionClass,
      item.context,
      config.attentionWindowMs ?? 30 * 24 * 60 * 60 * 1000,
      now,
    );
    const evidence = preference?.evidenceSummary ?? deriveEvidenceSummary([]);
    const confidence = preference?.confidence ?? computeConfidence(evidence);
    const rung = preference?.rung ?? 'surface';
    const boost = computeBoost(preference, attentionWeight, config.rankingBoostScale ?? 1.0);
    const score = item.basePriority + boost;

    const explanation: RankingExplanation = {
      basePriority: item.basePriority,
      attentionWeight,
      rung,
      confidence,
      evidenceSummary: evidence,
    };

    return {
      decisionId: item.decisionId,
      decisionClass: item.decisionClass,
      context: item.context,
      basePriority: item.basePriority,
      score,
      explanation,
    };
  });

  // Stable sort by score descending; never drop items.
  return ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.decisionId.localeCompare(b.decisionId);
  });
}

export function selectPullTimeRelevance(
  candidates: InboxItem[],
  context: string,
  observations: Observation[],
  config: Pick<OperatorLearningConfig, 'thresholds' | 'guardedClasses' | 'attentionWindowMs' | 'rankingBoostScale'>,
  now = Date.now(),
  approvedKeys: Set<string> = new Set(),
): { item: InboxItem; reason: string } | undefined {
  const thresholds = config.thresholds ?? DEFAULT_RUNG_THRESHOLDS;
  const sameContext = candidates.filter((c) => c.context === context);
  const pool = sameContext.length > 0 ? sameContext : candidates;

  const preferences = buildPreferenceMap(
    observations,
    pool,
    { thresholds, guardedClasses: config.guardedClasses },
    approvedKeys,
  );

  let best: InboxItem | undefined;
  let bestScore = -Infinity;
  for (const item of pool) {
    const key = `${item.decisionClass}::${item.context}`;
    const preference = preferences.get(key);
    const attentionWeight = computeAttentionWeight(
      observations,
      item.decisionClass,
      item.context,
      config.attentionWindowMs ?? 30 * 24 * 60 * 60 * 1000,
      now,
    );
    const score = item.basePriority + computeBoost(preference, attentionWeight, config.rankingBoostScale ?? 1.0);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best) return undefined;

  const key = `${best.decisionClass}::${best.context}`;
  const preference = preferences.get(key);
  const rung = preference?.rung ?? 'surface';
  const confidence = preference?.confidence ?? 0;
  const reason = `Selected by learned attention (class=${best.decisionClass}, rung=${rung}, confidence=${confidence.toFixed(2)}) in context '${context}'`;
  return { item: best, reason };
}
