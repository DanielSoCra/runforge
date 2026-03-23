// src/knowledge/candidate-queue.ts
import type { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeRecord } from './record-types.js';

export async function getCandidates(store: KnowledgeStore): Promise<KnowledgeRecord[]> {
  const all = await store.loadAll();
  return all.filter(r => r.lifecycleStatus === 'candidate');
}

export async function approveCandidate(store: KnowledgeStore, id: string): Promise<void> {
  await store.transitionStatus(id, 'active', 'candidate');
}

export async function rejectCandidate(store: KnowledgeStore, id: string): Promise<void> {
  await store.transitionStatus(id, 'archived', 'candidate');
}

export async function archiveExpiredCandidates(
  store: KnowledgeStore,
  timeoutDays: number = 14,
): Promise<string[]> {
  const all = await store.loadAll();
  const now = Date.now();
  const timeoutMs = timeoutDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for (const r of all) {
    if (r.lifecycleStatus !== 'candidate') continue;
    if (now - new Date(r.createdAt).getTime() > timeoutMs) {
      try {
        await store.transitionStatus(r.id, 'archived', 'candidate');
        expired.push(r.id);
      } catch {
        // Record was already transitioned (approved or rejected) — skip
      }
    }
  }
  return expired;
}
