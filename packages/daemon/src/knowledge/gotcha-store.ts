// src/knowledge/gotcha-store.ts
import { appendJsonl, readJsonl, writeTextSafe } from '../lib/json-store.js';
import { minimatch } from 'minimatch';
import type { Gotcha } from '../types.js';
import { randomUUID } from 'crypto';

export class GotchaStore {
  private compacting = false;

  constructor(private path: string) {}

  async store(markers: Array<{ artifactPatterns: string[]; description: string }>, sourceIssue: number, originType: 'autonomous' | 'operator' = 'autonomous'): Promise<number> {
    let stored = 0;
    const existing = await this.loadAll();
    for (const marker of markers) {
      const duplicate = existing.find((g) =>
        this.patternsMatch(g.artifactPatterns, marker.artifactPatterns) &&
        g.description.toLowerCase() === marker.description.toLowerCase(),
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

  async getPromotionCandidates(threshold: number = 5, maxAgeDays: number = 90): Promise<Gotcha[]> {
    const all = await this.loadAll();
    const now = Date.now();
    return all.filter((g) => {
      if (g.promoted || g.archived) return false;
      const age = (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (age > maxAgeDays) return false;
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

  async archive(id: string): Promise<void> {
    const all = await this.loadAll();
    const gotcha = all.find((g) => g.id === id);
    if (gotcha) {
      gotcha.archived = true;
      await appendJsonl(this.path, gotcha);
      await this.compactIfNeeded();
    }
  }

  async compact(): Promise<void> {
    const all = await this.loadAll();
    const active = all.filter((g) => !g.archived);
    await writeTextSafe(this.path, active.map((g) => JSON.stringify(g)).join('\n') + '\n');
  }

  private async compactIfNeeded(): Promise<void> {
    if (this.compacting) return;
    const entries = await readJsonl<Gotcha>(this.path);
    const unique = new Set(entries.map((e) => e.id)).size;
    if (entries.length >= 50 && entries.length >= unique * 2) {
      this.compacting = true;
      try {
        await this.compact();
      } finally {
        this.compacting = false;
      }
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
