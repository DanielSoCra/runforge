// packages/daemon/src/knowledge/enriched-commits.ts
//
// Extract institutional knowledge from structured markers embedded in git commit
// messages. Works as a post-completion consumer: read the branch log, parse
// KNOWLEDGE/PITFALL markers, and submit them to the knowledge store.

import { git } from '../lib/git.js';
import { extractKnowledgeMarkers } from './extractor.js';
import type { KnowledgeStore } from './knowledge-store.js';

export interface EnrichedCommitConsumerDeps {
  knowledgeStore: KnowledgeStore;
  gitCwd?: string;
}

export interface EnrichedCommitResult {
  commitsRead: number;
  recordsStored: number;
}

export async function consumeEnrichedCommits(
  sourceId: string,
  baseRef: string,
  headRef: string,
  deps: EnrichedCommitConsumerDeps,
): Promise<EnrichedCommitResult> {
  const logResult = await git(
    ['log', `${baseRef}..${headRef}`, '--pretty=format:%B%x00'],
    deps.gitCwd,
  );
  if (!logResult.ok) {
    console.warn(`[enriched-commits] failed to read log for ${sourceId}:`, logResult.error.message);
    return { commitsRead: 0, recordsStored: 0 };
  }

  const messages = logResult.value.split('\u0000').filter((m) => m.trim().length > 0);
  let recordsStored = 0;
  for (const message of messages) {
    const markers = extractKnowledgeMarkers(message);
    if (markers.length === 0) continue;
    const stored = await deps.knowledgeStore.storeRecord(
      markers,
      sourceId,
      'autonomous',
      'technical_pitfall',
    );
    recordsStored += stored;
  }

  if (recordsStored > 0) {
    console.log(
      `[enriched-commits] stored ${recordsStored} record(s) from ${messages.length} commit(s) for ${sourceId}`,
    );
  }

  return { commitsRead: messages.length, recordsStored };
}
