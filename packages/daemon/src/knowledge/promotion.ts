// src/knowledge/promotion.ts
import type { GotchaStore } from './gotcha-store.js';
import type { Gotcha } from '../types.js';

export interface PromotionCandidate {
  gotcha: Gotcha;
  suggestedDocContent: string;
}

export async function getPromotionCandidates(
  store: GotchaStore,
  threshold?: number,
): Promise<PromotionCandidate[]> {
  const candidates = await store.getPromotionCandidates(threshold);
  return candidates.map((g) => ({
    gotcha: g,
    suggestedDocContent: `## ${g.description}\n\nAffects: ${g.artifactPatterns.join(', ')}\nSource: Issue #${g.sourceIssue}\nHits: ${g.hitCount}`,
  }));
}
