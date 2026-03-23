// src/knowledge/promotion.ts
import type { GotchaStore } from './gotcha-store.js';
import type { Gotcha } from '../types.js';
import type { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeRecord } from './record-types.js';

export interface PromotionCandidate {
  gotcha: Gotcha;
  suggestedDocContent: string;
}

export interface KnowledgePromotionCandidate {
  record: KnowledgeRecord;
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

export async function getKnowledgePromotionCandidates(
  store: KnowledgeStore,
  cooldownDays?: number,
): Promise<KnowledgePromotionCandidate[]> {
  const candidates = await store.getPromotionCandidates(cooldownDays);
  return candidates.map((r) => ({
    record: r,
    suggestedDocContent: `## ${r.description}\n\nType: ${r.recordType}\nAffects: ${r.artifactPatterns.join(', ')}\nSource: ${r.sourceId}\nHits: ${r.hitCount}`,
  }));
}
