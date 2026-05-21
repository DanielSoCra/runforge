// src/knowledge/gotcha-store.ts
import { appendJsonl, readJsonl, writeTextSafe } from '../lib/json-store.js';
import { minimatch } from 'minimatch';
import type { Gotcha } from '../types.js';
import { randomUUID } from 'crypto';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'if', 'or', 'and', 'but', 'not', 'no', 'so', 'than', 'too', 'very',
  'just', 'that', 'this', 'it', 'its',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\s+/).filter((w) => w.length > 0 && !STOPWORDS.has(w)),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export class GotchaStore {
  /** Promise-based mutex — serializes all file-mutating operations so compact's
   *  read-modify-write cannot interleave with concurrent appends (#295). */
  private mutex: Promise<void> = Promise.resolve();

  private archivePath: string;
  private recordsCache: Gotcha[] | null = null;
  private logEntryCount: number | null = null;

  constructor(private path: string) {
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

  async store(markers: Array<{ artifactPatterns: string[]; description: string }>, sourceIssue: number, originType: 'autonomous' | 'operator' = 'autonomous'): Promise<number> {
    return this.withMutex(async () => {
      let stored = 0;
      const existing = await this.loadAll();
      for (const marker of markers) {
        const markerTokens = tokenize(marker.description);
        const duplicate = existing.find((g) =>
          this.patternsMatch(g.artifactPatterns, marker.artifactPatterns) &&
          jaccardSimilarity(tokenize(g.description), markerTokens) > 0.7,
        );
        if (duplicate) {
          let updated: Gotcha = { ...duplicate, hitCount: duplicate.hitCount + 1 };
          if (originType === 'operator' && duplicate.originType !== 'operator') {
            updated = {
              ...updated,
              originType: 'operator',
              priorityTier: 'elevated',
            };
          }
          await this.appendLatestGotcha(updated);
        } else {
          const gotcha: Gotcha = {
            id: randomUUID(),
            artifactPatterns: marker.artifactPatterns,
            description: marker.description,
            sourceIssue,
            confidence: 1,
            createdAt: new Date().toISOString(),
            hitCount: 1,
            promoted: false,
            archived: false,
            originType,
            priorityTier: originType === 'operator' ? 'elevated' : 'normal',
          };
          await this.appendLatestGotcha(gotcha);
          stored++;
        }
      }
      await this.compactIfNeeded();
      return stored;
    });
  }

  async match(artifactPaths: string[]): Promise<Gotcha[]> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const matched = all
        .filter((g) => !g.promoted && !g.archived)
        .filter((g) => g.artifactPatterns.some((pattern) =>
          artifactPaths.some((path) => minimatch(path, pattern, { dot: true })),
        ));
      // Increment hit counts for each matched gotcha (ARCH-AC-KNOWLEDGE §match-gotchas)
      const updatedMatched = matched.map(gotcha => ({
        ...gotcha,
        hitCount: gotcha.hitCount + 1,
      }));
      for (const gotcha of updatedMatched) {
        await this.appendLatestGotcha(gotcha);
      }
      await this.compactIfNeeded();
      updatedMatched.sort((a, b) => {
        const tierOrder = (t: string) => t === 'elevated' ? 1 : 0;
        return tierOrder(b.priorityTier) - tierOrder(a.priorityTier) || b.hitCount - a.hitCount;
      });
      return this.cloneGotchas(updatedMatched);
    });
  }

  async incrementHitCount(id: string): Promise<void> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const gotcha = all.find((g) => g.id === id);
      if (gotcha) {
        await this.appendLatestGotcha({
          ...gotcha,
          hitCount: gotcha.hitCount + 1,
        });
        await this.compactIfNeeded();
      }
    });
  }

  async getPromotionCandidates(threshold: number = 5, maxAgeDays: number = 90, cooldownDays: number = 30): Promise<Gotcha[]> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const now = Date.now();
      return this.cloneGotchas(all.filter((g) => {
        if (g.promoted || g.archived) return false;
        const age = (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (age > maxAgeDays) return false;
        if (g.reviewedAt) {
          const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
          if (new Date(g.reviewedAt).getTime() + cooldownMs > now) return false;
        }
        const effectiveThreshold = g.priorityTier === 'elevated' ? Math.floor(threshold / 2) : threshold;
        return g.hitCount >= effectiveThreshold;
      }));
    });
  }

  async promote(id: string): Promise<void> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const gotcha = all.find((g) => g.id === id);
      if (gotcha) {
        await this.appendLatestGotcha({
          ...gotcha,
          promoted: true,
        });
        await this.compactIfNeeded();
      }
    });
  }

  async rejectPromotion(id: string): Promise<void> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const gotcha = all.find((g) => g.id === id);
      if (gotcha) {
        await this.appendLatestGotcha({
          ...gotcha,
          reviewedAt: new Date().toISOString(),
        });
        await this.compactIfNeeded();
      }
    });
  }

  async archive(id: string): Promise<void> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const gotcha = all.find((g) => g.id === id);
      if (gotcha) {
        await this.appendLatestGotcha({
          ...gotcha,
          archived: true,
        });
        await this.compactIfNeeded();
      }
    });
  }

  async scanForArchival(maxAgeDays: number = 90, minHitCount: number = 2): Promise<string[]> {
    return this.withMutex(async () => {
      const all = await this.loadAll();
      const now = Date.now();
      const toArchive: string[] = [];
      for (const g of all) {
        if (g.promoted || g.archived) continue;
        // Operator corrections are exempt from automatic archival (ARCH-AC-KNOWLEDGE §archival-flow)
        if (g.originType === 'operator') continue;
        const age = (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (age > maxAgeDays && g.hitCount < minHitCount) {
          await this.appendLatestGotcha({
            ...g,
            archived: true,
          });
          toArchive.push(g.id);
        }
      }
      if (toArchive.length > 0) await this.compactIfNeeded();
      return toArchive;
    });
  }

  async compact(): Promise<void> {
    return this.withMutex(() => this.doCompact());
  }

  /** Internal compact — callers must already hold the mutex. */
  private async doCompact(): Promise<void> {
    const all = await this.loadAll();
    const archived = all.filter((g) => g.archived);
    const active = all.filter((g) => !g.archived);
    // Move archived entries to archive file per L3 spec (retained for historical reference)
    for (const g of archived) {
      await appendJsonl(this.archivePath, g);
    }
    await writeTextSafe(this.path, active.map((g) => JSON.stringify(g)).join('\n') + '\n');
    this.recordsCache = this.cloneGotchas(active);
    this.logEntryCount = active.length;
  }

  /** Called from within mutex-holding methods — no lock needed. */
  private async compactIfNeeded(): Promise<void> {
    const all = await this.loadAll();
    const entries = this.logEntryCount ?? all.length;
    if (entries >= 50 && entries >= all.length * 2) {
      await this.doCompact();
    }
  }

  private async loadAll(): Promise<Gotcha[]> {
    if (this.recordsCache) return this.recordsCache;
    const entries = await readJsonl<Gotcha>(this.path);
    // Last version of each ID wins
    const latest = new Map<string, Gotcha>();
    for (const entry of entries) {
      latest.set(entry.id, entry);
    }
    this.recordsCache = this.cloneGotchas([...latest.values()]);
    this.logEntryCount = entries.length;
    return this.recordsCache;
  }

  private cloneGotcha(gotcha: Gotcha): Gotcha {
    return {
      ...gotcha,
      artifactPatterns: [...gotcha.artifactPatterns],
    };
  }

  private cloneGotchas(gotchas: Gotcha[]): Gotcha[] {
    return gotchas.map(gotcha => this.cloneGotcha(gotcha));
  }

  private async appendLatestGotcha(gotcha: Gotcha): Promise<void> {
    await appendJsonl(this.path, gotcha);
    this.logEntryCount = (this.logEntryCount ?? 0) + 1;
    if (!this.recordsCache) return;

    const latest = this.cloneGotcha(gotcha);
    const index = this.recordsCache.findIndex(g => g.id === latest.id);
    if (index >= 0) {
      this.recordsCache[index] = latest;
    } else {
      this.recordsCache.push(latest);
    }
  }

  private patternsMatch(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((p, i) => p === sortedB[i]);
  }
}
