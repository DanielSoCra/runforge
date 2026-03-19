// src/knowledge/extractor.ts
import type { PitfallMarker } from '../types.js';

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
