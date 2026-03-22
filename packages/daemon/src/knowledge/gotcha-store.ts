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
  private compacting = false;

  constructor(private path: string) {}

  async store(markers: Array<{ artifactPatterns: string[]; description: string }>, sourceIssue: number, originType: 'autonomous' | 'operator' = 'autonomous'): Promise<number> {
    let stored = 0;
    const existing = await this.loadAll();
    for (const marker of markers) {
      const markerTokens = tokenize(marker.description);
      const duplicate = existing.find((g) =>
        this.patternsMatch(g.artifactPatterns, marker.artifactPatterns) &&
        jaccardSimilarity(tokenize(g.description), markerTokens) > 0.7,
      );
      if (duplicate) {
        duplicate.hitCount++;
        await appendJsonl(this.path, duplicate);
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
        await appendJsonl(this.path, gotcha);
        existing.push(gotcha);
        stored++;
      }
    }
    await this.compactIfNeeded();
    return stored;
  }

  async match(artifactPaths: string[]): Promise<Gotcha[]> {
    const all = await this.loadAll();
    const matched = all
      .filter((g) => !g.promoted && !g.archived)
      .filter((g) => g.artifactPatterns.some((pattern) =>
        artifactPaths.some((path) => minimatch(path, pattern, { dot: true })),
      ));
    // Increment hit counts for each matched gotcha (ARCH-AC-KNOWLEDGE §match-gotchas)
    for (const gotcha of matched) {
      gotcha.hitCount++;
      await appendJsonl(this.path, gotcha);
    }
    await this.compactIfNeeded();
    matched.sort((a, b) => {
      const tierOrder = (t: string) => t === 'elevated' ? 1 : 0;
      return tierOrder(b.priorityTier) - tierOrder(a.priorityTier) || b.hitCount - a.hitCount;
    });
    return matched;
  }

  async incrementHitCount(id: string): Promise<void> {
    const all = await this.loadAll();
    const gotcha = all.find((g) => g.id === id);
    if (gotcha) {
      gotcha.hitCount++;
      await appendJsonl(this.path, gotcha);
      await this.compactIfNeeded();
    }
  }

  async getPromotionCandidates(threshold: number = 5, maxAgeDays: number = 90, cooldownDays: number = 30): Promise<Gotcha[]> {
    const all = await this.loadAll();
    const now = Date.now();
    return all.filter((g) => {
      if (g.promoted || g.archived) return false;
      const age = (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > maxAgeDays) return false;
      if (g.reviewedAt) {
        const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
        if (new Date(g.reviewedAt).getTime() + cooldownMs > now) return false;
      }
      const effectiveThreshold = g.priorityTier === 'elevated' ? Math.floor(threshold / 2) : threshold;
      return g.hitCount >= effectiveThreshold;
    });
  }

  async promote(id: string): Promise<void> {
    const all = await this.loadAll();
    const gotcha = all.find((g) => g.id === id);
    if (gotcha) {
      gotcha.promoted = true;
      await appendJsonl(this.path, gotcha);
      await this.compactIfNeeded();
    }
  }

  async rejectPromotion(id: string): Promise<void> {
    const all = await this.loadAll();
    const gotcha = all.find((g) => g.id === id);
    if (gotcha) {
      gotcha.reviewedAt = new Date().toISOString();
      await appendJsonl(this.path, gotcha);
      await this.compactIfNeeded();
    }
  }

  async archive(id: string): Promise<void> {
    const all = await this.loadAll();
    const gotcha = all.find((g) => g.id === id);
    if (gotcha) {
      gotcha.archived = true;
      await appendJsonl(this.path, gotcha);
      await this.compactIfNeeded();
    }
  }

  async scanForArchival(maxAgeDays: number = 90, minHitCount: number = 2): Promise<string[]> {
    const all = await this.loadAll();
    const now = Date.now();
    const toArchive: string[] = [];
    for (const g of all) {
      if (g.promoted || g.archived) continue;
      const age = (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > maxAgeDays && g.hitCount < minHitCount) {
        g.archived = true;
        await appendJsonl(this.path, g);
        toArchive.push(g.id);
      }
    }
    if (toArchive.length > 0) await this.compactIfNeeded();
    return toArchive;
  }

  async compact(): Promise<void> {
    const all = await this.loadAll();
    const active = all.filter((g) => !g.archived);
    await writeTextSafe(this.path, active.map((g) => JSON.stringify(g)).join('\n') + '\n');
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.compacting) return;
    this.compacting = true;
    try {
      const entries = await readJsonl<Gotcha>(this.path);
      const unique = new Set(entries.map((e) => e.id)).size;
      if (entries.length >= 50 && entries.length >= unique * 2) {
        await this.compact();
      }
    } finally {
      this.compacting = false;
    }
  }

  private async loadAll(): Promise<Gotcha[]> {
    const entries = await readJsonl<Gotcha>(this.path);
    // Last version of each ID wins
    const latest = new Map<string, Gotcha>();
    for (const entry of entries) {
      latest.set(entry.id, entry);
    }
    return [...latest.values()];
  }

  private patternsMatch(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((p, i) => p === sortedB[i]);
  }
}
