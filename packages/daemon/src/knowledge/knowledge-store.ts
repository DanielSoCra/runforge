// src/knowledge/knowledge-store.ts
import { appendJsonl, readJsonl, writeTextSafe } from '../lib/json-store.js';
import { minimatch } from 'minimatch';
import { randomUUID } from 'crypto';
import { rename, access } from 'fs/promises';
import { KnowledgeRecordSchema, type KnowledgeRecord, type RecordType, type OriginType } from './record-types.js';
import type { PolicyRegistry } from './policy-registry.js';
import { tokenize, jaccardSimilarity } from './gotcha-store.js';

export interface RecordMarker {
  artifactPatterns: string[];
  description: string;
  rootCauseTag?: string;
  reasoning?: string;
}

export class KnowledgeStore {
  private mutex: Promise<void> = Promise.resolve();
  private archivePath: string;
  private migrated = false;

  constructor(
    private path: string,
    private policies: PolicyRegistry,
    private v1GotchaPath?: string,
  ) {
    this.archivePath = path.replace(/\.jsonl$/, '-archive.jsonl');
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const prev = this.mutex;
    this.mutex = gate;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async storeRecord(
    markers: RecordMarker[],
    sourceId: string,
    originType: OriginType,
    recordType: RecordType,
  ): Promise<number> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      let stored = 0;
      const existing = await this.loadAllInternal();
      for (const marker of markers) {
        const markerTokens = tokenize(marker.description);
        const duplicate = existing.find(r =>
          r.recordType === recordType &&
          r.lifecycleStatus !== 'archived' &&
          this.patternsMatch(r.artifactPatterns, marker.artifactPatterns) &&
          jaccardSimilarity(tokenize(r.description), markerTokens) > 0.7,
        );
        if (duplicate) {
          duplicate.hitCount++;
          if (originType === 'operator' && duplicate.originType !== 'operator') {
            duplicate.originType = 'operator';
            duplicate.priorityTier = 'elevated';
          }
          await appendJsonl(this.path, duplicate);
        } else {
          const lifecycleStatus = (originType === 'retrospective-tech-lead' || originType === 'retrospective-po')
            ? 'candidate' as const
            : 'active' as const;
          const priorityTier = originType === 'operator' ? 'elevated' as const : 'normal' as const;
          const record: KnowledgeRecord = {
            id: randomUUID(),
            recordType,
            artifactPatterns: marker.artifactPatterns,
            description: marker.description,
            sourceId,
            confidence: 1,
            createdAt: new Date().toISOString(),
            hitCount: 1,
            lifecycleStatus,
            originType,
            priorityTier,
            rootCauseTag: marker.rootCauseTag,
            reasoning: marker.reasoning,
          };
          await appendJsonl(this.path, record);
          existing.push(record);
          stored++;
        }
      }
      await this.compactIfNeeded();
      return stored;
    });
  }

  async matchRecords(
    artifactPaths: string[],
    sessionType: string,
    recordTypeFilter?: RecordType,
  ): Promise<KnowledgeRecord[]> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      const all = await this.loadAllInternal();

      // Determine eligible record types based on session type
      const eligibleTypes = recordTypeFilter
        ? [recordTypeFilter]
        : (Object.entries(this.policies) as [RecordType, { injectionTargets: string[] }][])
          .filter(([, p]) => p.injectionTargets.includes(sessionType))
          .map(([type]) => type);

      const matched = all
        .filter(r => r.lifecycleStatus === 'active')
        .filter(r => eligibleTypes.includes(r.recordType))
        .filter(r => r.artifactPatterns.some(pattern =>
          artifactPaths.some(path => minimatch(path, pattern, { dot: true })),
        ));

      // Increment hit counts
      for (const record of matched) {
        record.hitCount++;
        await appendJsonl(this.path, record);
      }

      // Sort per each type's sortOrder policy, with elevated always first
      matched.sort((a, b) => {
        // Elevated always comes first regardless of type
        const tierOrder = (t: string) => t === 'elevated' ? 1 : 0;
        const tierDiff = tierOrder(b.priorityTier) - tierOrder(a.priorityTier);
        if (tierDiff !== 0) return tierDiff;

        // Within same tier, use type-specific sort order
        const aPolicy = this.policies[a.recordType];
        const order = aPolicy.sortOrder;
        if (order === 'recency') {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        if (order === 'severity_then_recency') {
          const hitDiff = b.hitCount - a.hitCount;
          if (hitDiff !== 0) return hitDiff;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        // priority_then_hits (default)
        return b.hitCount - a.hitCount;
      });

      await this.compactIfNeeded();
      return matched;
    });
  }

  async transitionStatus(id: string, newStatus: KnowledgeRecord['lifecycleStatus']): Promise<void> {
    return this.withMutex(async () => {
      const all = await this.loadAllInternal();
      const record = all.find(r => r.id === id);
      if (record) {
        record.lifecycleStatus = newStatus;
        if (newStatus === 'archived') {
          record.reviewedAt = new Date().toISOString();
        }
        await appendJsonl(this.path, record);
        await this.compactIfNeeded();
      }
    });
  }

  async queryByRootCause(tag: string): Promise<KnowledgeRecord[]> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      const all = await this.loadAllInternal();
      return all.filter(r => r.rootCauseTag === tag);
    });
  }

  async loadAll(): Promise<KnowledgeRecord[]> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      return this.loadAllInternal();
    });
  }

  async getPromotionCandidates(cooldownDays: number = 30): Promise<KnowledgeRecord[]> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      const all = await this.loadAllInternal();
      const now = Date.now();
      return all.filter(r => {
        if (r.lifecycleStatus !== 'active') return false;
        const policy = this.policies[r.recordType];
        const age = (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (age > policy.promotionMaxAgeDays) return false;
        if (r.reviewedAt) {
          const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
          if (new Date(r.reviewedAt).getTime() + cooldownMs > now) return false;
        }
        return r.hitCount >= policy.promotionThreshold;
      });
    });
  }

  async scanForArchival(): Promise<string[]> {
    return this.withMutex(async () => {
      await this.migrateIfNeeded();
      const all = await this.loadAllInternal();
      const now = Date.now();
      const toArchive: string[] = [];
      for (const r of all) {
        if (r.lifecycleStatus !== 'active') continue;
        const policy = this.policies[r.recordType];
        if (policy.archivalMaxAgeDays === Infinity) continue;
        const age = (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (age > policy.archivalMaxAgeDays && r.hitCount < policy.archivalMinHitCount) {
          r.lifecycleStatus = 'archived';
          await appendJsonl(this.path, r);
          toArchive.push(r.id);
        }
      }
      if (toArchive.length > 0) await this.compactIfNeeded();
      return toArchive;
    });
  }

  async compact(): Promise<void> {
    return this.withMutex(() => this.doCompact());
  }

  private async doCompact(): Promise<void> {
    const all = await this.loadAllInternal();
    const archived = all.filter(r => r.lifecycleStatus === 'archived');
    const active = all.filter(r => r.lifecycleStatus !== 'archived');
    for (const r of archived) {
      await appendJsonl(this.archivePath, r);
    }
    await writeTextSafe(this.path, active.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  private async compactIfNeeded(): Promise<void> {
    const entries = await readJsonl<KnowledgeRecord>(this.path);
    const unique = new Set(entries.map(e => e.id)).size;
    if (entries.length >= 50 && entries.length >= unique * 2) {
      await this.doCompact();
    }
  }

  private async loadAllInternal(): Promise<KnowledgeRecord[]> {
    const entries = await readJsonl<Record<string, unknown>>(this.path);
    const latest = new Map<string, KnowledgeRecord>();
    for (const entry of entries) {
      const result = KnowledgeRecordSchema.safeParse(entry);
      if (!result.success) continue; // skip malformed/corrupt entries
      latest.set(result.data.id, result.data);
    }
    return [...latest.values()];
  }

  private patternsMatch(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((p, i) => p === sortedB[i]);
  }

  private async migrateIfNeeded(): Promise<void> {
    if (this.migrated || !this.v1GotchaPath) return;
    this.migrated = true;

    // Check if knowledge.jsonl already exists
    try {
      await access(this.path);
      return; // already exists, no migration needed
    } catch {
      // doesn't exist, check for v1 file
    }

    try {
      await access(this.v1GotchaPath);
    } catch {
      return; // no v1 file either
    }

    // Migrate v1 gotchas to v2 knowledge records
    const v1Entries = await readJsonl<Record<string, unknown>>(this.v1GotchaPath);
    for (const entry of v1Entries) {
      const record: KnowledgeRecord = {
        id: (entry.id as string) || randomUUID(),
        recordType: 'technical_pitfall',
        artifactPatterns: (entry.artifactPatterns as string[]) || [],
        description: (entry.description as string) || '',
        sourceId: `issue-${entry.sourceIssue ?? 0}`,
        confidence: (entry.confidence as number) ?? 1,
        createdAt: (entry.createdAt as string) || new Date().toISOString(),
        hitCount: (entry.hitCount as number) ?? 1,
        lifecycleStatus: entry.promoted ? 'promoted' : entry.archived ? 'archived' : 'active',
        originType: ((entry.originType as string) === 'operator' ? 'operator' : 'autonomous') as KnowledgeRecord['originType'],
        priorityTier: ((entry.priorityTier as string) === 'elevated' ? 'elevated' : 'normal') as KnowledgeRecord['priorityTier'],
      };
      await appendJsonl(this.path, record);
    }
    await rename(this.v1GotchaPath, this.v1GotchaPath + '.migrated');
  }
}
