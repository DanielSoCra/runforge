// src/coordination/tech-lead/enrichment.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { storeEnrichment, getEnrichmentForProposal } from './enrichment.js';
import { TechProposalStore } from './proposal-store.js';

let tmpDir: string;
let store: TechProposalStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tl-enrich-'));
  store = new TechProposalStore(join(tmpDir, 'proposals'), join(tmpDir, 'enrichments'));
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('storeEnrichment', () => {
  it('stores and retrieves enrichment', async () => {
    const proposalId = crypto.randomUUID();
    const enrichment = await storeEnrichment({
      proposalId,
      effortEstimate: '3 days',
      dependencies: ['lodash'],
      technicalRisks: ['API breakage'],
      prerequisites: ['#100'],
    }, store);

    expect(enrichment.id).toBeTruthy();
    expect(enrichment.proposalId).toBe(proposalId);

    const loaded = await getEnrichmentForProposal(proposalId, store);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(enrichment.id);
  });

  it('stores enrichment with unassessed effort', async () => {
    const enrichment = await storeEnrichment({
      proposalId: crypto.randomUUID(),
      effortEstimate: 'unassessed',
      dependencies: [],
      technicalRisks: [],
      prerequisites: [],
    }, store);

    expect(enrichment.effortEstimate).toBe('unassessed');
  });
});

describe('getEnrichmentForProposal', () => {
  it('returns null for non-existent proposal', async () => {
    const result = await getEnrichmentForProposal(crypto.randomUUID(), store);
    expect(result).toBeNull();
  });
});
