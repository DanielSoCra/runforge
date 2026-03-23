// src/coordination/tech-lead/enrichment.ts — Store and manage TechnicalEnrichments
import { randomUUID } from 'crypto';
import type { TechnicalEnrichment } from './schemas.js';
import type { TechProposalStore } from './proposal-store.js';

export interface EnrichmentInput {
  proposalId: string;
  effortEstimate: string | 'unassessed';
  dependencies: string[];
  technicalRisks: string[];
  prerequisites: string[];
}

export async function storeEnrichment(
  input: EnrichmentInput,
  store: TechProposalStore,
): Promise<TechnicalEnrichment> {
  const enrichment: TechnicalEnrichment = {
    id: randomUUID(),
    proposalId: input.proposalId,
    effortEstimate: input.effortEstimate,
    dependencies: input.dependencies,
    technicalRisks: input.technicalRisks,
    prerequisites: input.prerequisites,
    createdAt: new Date().toISOString(),
  };

  await store.saveEnrichment(enrichment);
  return enrichment;
}

export async function getEnrichmentForProposal(
  proposalId: string,
  store: TechProposalStore,
): Promise<TechnicalEnrichment | null> {
  return store.loadEnrichmentByProposalId(proposalId);
}
