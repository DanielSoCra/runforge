// src/coordination/product-owner/proposal-generator.ts — File-based persistence for PO RawProposals
import { randomUUID } from 'crypto';
import { join } from 'path';
import { readdir, mkdir } from 'fs/promises';
import { writeJsonSafe, readJsonSafe } from '../../lib/json-store.js';
import { z } from 'zod';
import { RawProposalSchema, type RawProposal, type ProposalType } from './schemas.js';

const ProposalStatusSchema = z.enum(['proposed', 'approved', 'rejected', 'expired']);
type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

const StoredProposalSchema = RawProposalSchema.extend({
  id: z.string(),
  status: ProposalStatusSchema,
  createdAt: z.string().datetime(),
});
type StoredProposal = z.infer<typeof StoredProposalSchema>;

export { type StoredProposal, type ProposalStatus };

export class POProposalStore {
  constructor(private proposalsDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.proposalsDir, { recursive: true });
  }

  async saveRawProposal(raw: RawProposal): Promise<string> {
    const id = randomUUID();
    const stored: StoredProposal = {
      ...raw,
      id,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };
    await writeJsonSafe(join(this.proposalsDir, `${id}.json`), stored);
    return id;
  }

  async loadProposal(id: string): Promise<StoredProposal | null> {
    const result = await readJsonSafe<unknown>(join(this.proposalsDir, `${id}.json`));
    if (!result.ok) return null;
    const parsed = StoredProposalSchema.safeParse(result.value);
    return parsed.success ? parsed.data : null;
  }

  async loadAllProposals(): Promise<StoredProposal[]> {
    const files = await this.listJsonFiles();
    const proposals: StoredProposal[] = [];
    for (const file of files) {
      const result = await readJsonSafe<unknown>(join(this.proposalsDir, file));
      if (!result.ok) continue;
      const parsed = StoredProposalSchema.safeParse(result.value);
      if (parsed.success) proposals.push(parsed.data);
    }
    return proposals;
  }

  async loadActiveProposals(): Promise<StoredProposal[]> {
    const all = await this.loadAllProposals();
    return all.filter(p => p.status === 'proposed');
  }

  async updateStatus(id: string, status: ProposalStatus): Promise<void> {
    const proposal = await this.loadProposal(id);
    if (!proposal) return;
    const updated = { ...proposal, status };
    await writeJsonSafe(join(this.proposalsDir, `${id}.json`), updated);
  }

  async findDuplicate(
    proposalType: ProposalType,
    relatedRefs: string[],
  ): Promise<StoredProposal | undefined> {
    const active = await this.loadActiveProposals();
    return active.find(
      p =>
        p.proposalType === proposalType &&
        setOverlap(p.relatedRefs, relatedRefs) > 0.5,
    );
  }

  private async listJsonFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.proposalsDir);
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
