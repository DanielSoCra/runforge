// src/knowledge/pattern-extractor.ts
import type { Gotcha, Pattern } from '../types.js';
import type { KnowledgeRecord } from './record-types.js';
import { tokenize, jaccardSimilarity } from './gotcha-store.js';

interface HasIdPatternsDescription {
  id: string;
  artifactPatterns: string[];
  description: string;
}

function artifactPatternsOverlap(a: string[], b: string[]): boolean {
  return a.some((pa) => b.some((pb) => pa === pb));
}

function extractPatternsGeneric<T extends HasIdPatternsDescription>(
  entries: T[],
  getSourceSpec: (entry: T) => string,
): Pattern[] {
  if (entries.length < 3) return [];

  const adjacency = new Map<string, Set<string>>();
  for (const e of entries) adjacency.set(e.id, new Set());

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (!artifactPatternsOverlap(a.artifactPatterns, b.artifactPatterns)) continue;
      const sim = jaccardSimilarity(tokenize(a.description), tokenize(b.description));
      if (sim > 0.5) {
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
      }
    }
  }

  const visited = new Set<string>();
  const groups: T[][] = [];

  for (const e of entries) {
    if (visited.has(e.id)) continue;
    const group: T[] = [];
    const stack = [e.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const entry = entries.find((x) => x.id === id)!;
      group.push(entry);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    if (group.length >= 3) groups.push(group);
  }

  return groups.map((group) => {
    const tokenSets = group.map((e) => tokenize(e.description));
    const commonTokens = [...tokenSets[0]!].filter((t) =>
      tokenSets.every((s) => s.has(t)),
    );
    const key = commonTokens.slice(0, 5).join('-') || `pattern-${group[0]!.id.slice(0, 8)}`;
    const confidence = Math.min(1, group.length / 10);
    const sourceSpecs = [...new Set(group.map((e) => getSourceSpec(e)))];

    return {
      key,
      description: `Recurring pattern across ${group.length} observations: ${commonTokens.join(' ') || group[0]!.description}`,
      confidence,
      sourceSpecs,
    };
  });
}

export function extractPatterns(gotchas: Gotcha[]): Pattern[] {
  return extractPatternsGeneric(gotchas, (g) => `issue-${g.sourceIssue}`);
}

export function extractPatternsFromRecords(records: KnowledgeRecord[]): Pattern[] {
  return extractPatternsGeneric(records, (r) => r.sourceId);
}
