// src/knowledge/pattern-extractor.ts
import type { Gotcha, Pattern } from '../types.js';
import { tokenize, jaccardSimilarity } from './gotcha-store.js';

function artifactPatternsOverlap(a: string[], b: string[]): boolean {
  return a.some((pa) => b.some((pb) => pa === pb));
}

export function extractPatterns(gotchas: Gotcha[]): Pattern[] {
  if (gotchas.length < 3) return [];

  // Build adjacency: pairs with overlapping artifact patterns and >50% description similarity
  const adjacency = new Map<string, Set<string>>();
  for (const g of gotchas) adjacency.set(g.id, new Set());

  for (let i = 0; i < gotchas.length; i++) {
    for (let j = i + 1; j < gotchas.length; j++) {
      const a = gotchas[i]!;
      const b = gotchas[j]!;
      if (!artifactPatternsOverlap(a.artifactPatterns, b.artifactPatterns)) continue;
      const sim = jaccardSimilarity(tokenize(a.description), tokenize(b.description));
      if (sim > 0.5) {
        adjacency.get(a.id)!.add(b.id);
        adjacency.get(b.id)!.add(a.id);
      }
    }
  }

  // Find connected components (groups)
  const visited = new Set<string>();
  const groups: Gotcha[][] = [];

  for (const g of gotchas) {
    if (visited.has(g.id)) continue;
    const group: Gotcha[] = [];
    const stack = [g.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const gotcha = gotchas.find((x) => x.id === id)!;
      group.push(gotcha);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    if (group.length >= 3) groups.push(group);
  }

  // Convert groups to patterns
  return groups.map((group) => {
    // Use intersection of tokens across descriptions as the pattern key
    const tokenSets = group.map((g) => tokenize(g.description));
    const commonTokens = [...tokenSets[0]!].filter((t) =>
      tokenSets.every((s) => s.has(t)),
    );
    const key = commonTokens.slice(0, 5).join('-') || `pattern-${group[0]!.id.slice(0, 8)}`;
    const confidence = Math.min(1, group.length / 10);
    const sourceSpecs = [...new Set(group.map((g) => `issue-${g.sourceIssue}`))];

    return {
      key,
      description: `Recurring pattern across ${group.length} observations: ${commonTokens.join(' ') || group[0]!.description}`,
      confidence,
      sourceSpecs,
    };
  });
}
