// src/coordination/tech-lead/retrospective.ts — Retrospective-to-knowledge flow: pitfall distillation
import type { TechLeadRetrospectiveOutput } from './schemas.js';

export interface KnowledgeStoreDep {
  storeRecord: (
    markers: Array<{
      artifactPatterns: string[];
      description: string;
      rootCauseTag?: string;
      reasoning?: string;
    }>,
    sourceId: string,
    originType: string,
    recordType: string,
  ) => Promise<number>;
}

export async function submitRetrospectivePitfalls(
  output: TechLeadRetrospectiveOutput,
  knowledge: KnowledgeStoreDep,
  sessionId: string,
): Promise<number> {
  if (output.pitfalls.length === 0) return 0;

  const markers = output.pitfalls.map(pitfall => ({
    artifactPatterns: pitfall.artifactPatterns,
    description: pitfall.description,
    rootCauseTag: pitfall.rootCauseTag,
    reasoning: `Severity: ${pitfall.severity}/10`,
  }));

  return knowledge.storeRecord(
    markers,
    sessionId,
    'retrospective-tech-lead',
    'technical_pitfall',
  );
}
