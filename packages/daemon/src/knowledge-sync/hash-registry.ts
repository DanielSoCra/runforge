// src/knowledge-sync/hash-registry.ts
import { createHash } from 'crypto';
import { appendJsonl, readJsonl } from '../lib/json-store.js';
import { SyncHashEntrySchema, type SyncHashEntry } from './types.js';

export function computeContentHash(
  artifactPatterns: string[],
  description: string,
): string {
  const input =
    [...artifactPatterns].sort().join(',') + '|' + description.trim();
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export class HashRegistry {
  constructor(private path: string) {}

  async has(contentHash: string): Promise<boolean> {
    const entries = await this.loadAll();
    return entries.some((e) => e.contentHash === contentHash);
  }

  async record(entry: SyncHashEntry): Promise<void> {
    await appendJsonl(this.path, entry);
  }

  private async loadAll(): Promise<SyncHashEntry[]> {
    const raw = await readJsonl<Record<string, unknown>>(this.path);
    return raw.flatMap((line) => {
      const result = SyncHashEntrySchema.safeParse(line);
      return result.success ? [result.data] : [];
    });
  }
}
