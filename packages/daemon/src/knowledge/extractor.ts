// src/knowledge/extractor.ts
import type { PitfallMarker } from '../types.js';
import type { RecordMarker } from './knowledge-store.js';

export function extractPitfalls(output: string): PitfallMarker[] {
  const markers: PitfallMarker[] = [];
  const regex = /<!-- PITFALL: ({.*?}) -->/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
      if (Array.isArray(parsed.artifactPatterns) && typeof parsed.description === 'string') {
        markers.push({
          artifactPatterns: parsed.artifactPatterns.map(String),
          description: parsed.description,
        });
      }
    } catch {
      // skip malformed
    }
  }
  return markers;
}

export function extractKnowledgeMarkers(output: string): RecordMarker[] {
  const markers: RecordMarker[] = [];
  const regex = /<!-- KNOWLEDGE: ({.*?}) -->/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
      if (Array.isArray(parsed.artifactPatterns) && typeof parsed.description === 'string') {
        markers.push({
          artifactPatterns: parsed.artifactPatterns.map(String),
          description: parsed.description,
          rootCauseTag: typeof parsed.rootCauseTag === 'string' ? parsed.rootCauseTag : undefined,
          reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
        });
      }
    } catch {
      // skip malformed
    }
  }
  // Also include legacy PITFALL markers as knowledge markers
  const pitfalls = extractPitfalls(output);
  for (const p of pitfalls) {
    markers.push({ artifactPatterns: p.artifactPatterns, description: p.description });
  }
  return markers;
}
