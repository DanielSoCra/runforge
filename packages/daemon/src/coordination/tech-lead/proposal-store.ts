// src/coordination/tech-lead/proposal-store.ts — File-based persistence for TechnicalProposals and TechnicalEnrichments
import { join } from 'path';
import { readdir, mkdir } from 'fs/promises';
import { writeJsonSafe, readJsonSafe } from '../../lib/json-store.js';
import {
  TechnicalProposalSchema,
  TechnicalEnrichmentSchema,
  type TechnicalProposal,
  type TechnicalEnrichment,
} from './schemas.js';

export class TechProposalStore {
  constructor(
    private proposalsDir: string,
    private enrichmentsDir: string,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.proposalsDir, { recursive: true });
    await mkdir(this.enrichmentsDir, { recursive: true });
  }

  // --- Proposals ---

  async saveProposal(proposal: TechnicalProposal): Promise<void> {
    await writeJsonSafe(join(this.proposalsDir, `${proposal.id}.json`), proposal);
  }

  async loadProposal(id: string): Promise<TechnicalProposal | null> {
    const result = await readJsonSafe<unknown>(join(this.proposalsDir, `${id}.json`));
    if (!result.ok) return null;
    const parsed = TechnicalProposalSchema.safeParse(result.value);
    return parsed.success ? parsed.data : null;
  }

  async loadAllProposals(): Promise<TechnicalProposal[]> {
    const files = await this.listJsonFiles(this.proposalsDir);
    const proposals: TechnicalProposal[] = [];
    for (const file of files) {
      const result = await readJsonSafe<unknown>(join(this.proposalsDir, file));
      if (!result.ok) continue;
      const parsed = TechnicalProposalSchema.safeParse(result.value);
      if (parsed.success) proposals.push(parsed.data);
    }
    return proposals;
  }

  async loadActiveProposals(): Promise<TechnicalProposal[]> {
    const all = await this.loadAllProposals();
    return all.filter(p =>
      p.status === 'generated' || p.status === 'forwarded' || p.status === 'pending_operator',
    );
  }

  async loadRejectedProposals(): Promise<TechnicalProposal[]> {
    const all = await this.loadAllProposals();
    return all.filter(p => p.status === 'rejected_by_po');
  }

  // --- Enrichments ---

  async saveEnrichment(enrichment: TechnicalEnrichment): Promise<void> {
    await writeJsonSafe(join(this.enrichmentsDir, `${enrichment.id}.json`), enrichment);
  }

  async loadEnrichment(id: string): Promise<TechnicalEnrichment | null> {
    const result = await readJsonSafe<unknown>(join(this.enrichmentsDir, `${id}.json`));
    if (!result.ok) return null;
    const parsed = TechnicalEnrichmentSchema.safeParse(result.value);
    return parsed.success ? parsed.data : null;
  }

  async loadEnrichmentByProposalId(proposalId: string): Promise<TechnicalEnrichment | null> {
    const files = await this.listJsonFiles(this.enrichmentsDir);
    for (const file of files) {
      const result = await readJsonSafe<unknown>(join(this.enrichmentsDir, file));
      if (!result.ok) continue;
      const parsed = TechnicalEnrichmentSchema.safeParse(result.value);
      if (parsed.success && parsed.data.proposalId === proposalId) return parsed.data;
    }
    return null;
  }

  // --- Deduplication ---

  async findDuplicate(
    proposalType: TechnicalProposal['proposalType'],
    affectedAreas: string[],
  ): Promise<TechnicalProposal | undefined> {
    const active = await this.loadActiveProposals();
    return active.find(
      p =>
        p.proposalType === proposalType &&
        setOverlap(p.affectedAreas, affectedAreas) > 0.5,
    );
  }

  // --- Private helpers ---

  private async listJsonFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir);
      return entries.filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }
  }
}

export function setOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const smaller = Math.min(setA.size, setB.size);
  return smaller === 0 ? 0 : intersection / smaller;
}
