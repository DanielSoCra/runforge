// src/knowledge/prospective-check.ts
import { minimatch } from 'minimatch';
import type { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeRecord } from './record-types.js';

/**
 * Read-only query — does NOT increment hit counts.
 * Returns active records matching paths that are high-severity
 * (elevated priority tier OR hitCount >= severityThreshold).
 */
export async function queryProspectiveRisks(
  store: KnowledgeStore,
  paths: string[],
  severityThreshold: number = 5,
): Promise<KnowledgeRecord[]> {
  const all = await store.loadAll();
  return all
    .filter(r => r.lifecycleStatus === 'active')
    .filter(r => r.priorityTier === 'elevated' || r.hitCount >= severityThreshold)
    .filter(r => r.artifactPatterns.some(pattern =>
      paths.some(path => minimatch(path, pattern, { dot: true })),
    ));
}
