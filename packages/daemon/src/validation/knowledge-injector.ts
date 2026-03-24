// src/validation/knowledge-injector.ts
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';

/**
 * Query the Knowledge Service for active records matching the reviewed area's
 * artifact paths. Format results as a "## Known Issues" section to prepend to
 * the reviewer session's context.
 *
 * Only call when actually spawning a reviewer session — matchRecords increments
 * hit counts on matched records.
 */
export async function injectKnowledge(
  artifactPaths: string[],
  store: KnowledgeStore,
  sessionType: string = 'review',
): Promise<string> {
  if (artifactPaths.length === 0) return '';
  const records = await store.matchRecords(artifactPaths, sessionType);
  if (records.length === 0) return '';
  return '## Known Issues\n' + records.map(r => `- ${r.description}`).join('\n');
}
