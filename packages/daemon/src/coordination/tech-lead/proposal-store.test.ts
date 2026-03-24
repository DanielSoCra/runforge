// src/coordination/tech-lead/proposal-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TechProposalStore, setOverlap } from './proposal-store.js';
import type { TechnicalProposal, TechnicalEnrichment } from './schemas.js';

function makeProposal(overrides: Partial<TechnicalProposal> = {}): TechnicalProposal {
  return {
    id: crypto.randomUUID(),
    proposalType: 'debt_reduction',
    title: 'Test proposal',
    evidence: [{ signal: 'test', detail: 'test' }],
    affectedAreas: ['src/validation/'],
    riskAssessment: 'Low',
    effortEstimate: '1 day',
    status: 'generated',
    poDecision: null,
    operatorDecision: null,
    priorRejectionId: null,
    expiresAt: new Date(Date.now() + 604800000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<TechnicalEnrichment> = {}): TechnicalEnrichment {
  return {
    id: crypto.randomUUID(),
    proposalId: crypto.randomUUID(),
    effortEstimate: '2 days',
    dependencies: ['lodash'],
    technicalRisks: ['API breakage'],
    prerequisites: ['#100'],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let tmpDir: string;
let store: TechProposalStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tl-store-'));
  store = new TechProposalStore(join(tmpDir, 'proposals'), join(tmpDir, 'enrichments'));
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('TechProposalStore — proposals', () => {
  it('saves and loads a proposal', async () => {
    const p = makeProposal();
    await store.saveProposal(p);
    const loaded = await store.loadProposal(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(p.id);
    expect(loaded!.title).toBe(p.title);
  });

  it('returns null for non-existent proposal', async () => {
    const loaded = await store.loadProposal(crypto.randomUUID());
    expect(loaded).toBeNull();
  });

  it('loads all proposals', async () => {
    const p1 = makeProposal();
    const p2 = makeProposal();
    await store.saveProposal(p1);
    await store.saveProposal(p2);
    const all = await store.loadAllProposals();
    expect(all).toHaveLength(2);
  });

  it('loads only active proposals', async () => {
    const active = makeProposal({ status: 'generated' });
    const terminal = makeProposal({ status: 'approved' });
    await store.saveProposal(active);
    await store.saveProposal(terminal);
    const result = await store.loadActiveProposals();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(active.id);
  });

  it('loads rejected proposals', async () => {
    const rejected = makeProposal({ status: 'rejected_by_po' });
    const other = makeProposal({ status: 'generated' });
    await store.saveProposal(rejected);
    await store.saveProposal(other);
    const result = await store.loadRejectedProposals();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(rejected.id);
  });

  it('overwrites proposal on save', async () => {
    const p = makeProposal({ status: 'generated' });
    await store.saveProposal(p);
    const updated = { ...p, status: 'forwarded' as const };
    await store.saveProposal(updated);
    const loaded = await store.loadProposal(p.id);
    expect(loaded!.status).toBe('forwarded');
  });
});

describe('TechProposalStore — enrichments', () => {
  it('saves and loads an enrichment', async () => {
    const e = makeEnrichment();
    await store.saveEnrichment(e);
    const loaded = await store.loadEnrichment(e.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.proposalId).toBe(e.proposalId);
  });

  it('loads enrichment by proposalId', async () => {
    const proposalId = crypto.randomUUID();
    const e = makeEnrichment({ proposalId });
    await store.saveEnrichment(e);
    const loaded = await store.loadEnrichmentByProposalId(proposalId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(e.id);
  });

  it('returns null for non-existent enrichment', async () => {
    const loaded = await store.loadEnrichmentByProposalId(crypto.randomUUID());
    expect(loaded).toBeNull();
  });
});

describe('TechProposalStore — deduplication', () => {
  it('finds duplicate with same type and overlapping areas', async () => {
    const existing = makeProposal({
      proposalType: 'debt_reduction',
      affectedAreas: ['src/validation/', 'src/lib/'],
      status: 'generated',
    });
    await store.saveProposal(existing);
    const dup = await store.findDuplicate('debt_reduction', ['src/validation/', 'src/lib/']);
    expect(dup).not.toBeUndefined();
    expect(dup!.id).toBe(existing.id);
  });

  it('returns undefined when no overlap', async () => {
    const existing = makeProposal({
      proposalType: 'debt_reduction',
      affectedAreas: ['src/validation/'],
      status: 'generated',
    });
    await store.saveProposal(existing);
    const dup = await store.findDuplicate('debt_reduction', ['src/knowledge/']);
    expect(dup).toBeUndefined();
  });

  it('returns undefined when different type', async () => {
    const existing = makeProposal({
      proposalType: 'debt_reduction',
      affectedAreas: ['src/validation/'],
      status: 'generated',
    });
    await store.saveProposal(existing);
    const dup = await store.findDuplicate('quality_improvement', ['src/validation/']);
    expect(dup).toBeUndefined();
  });
});

describe('setOverlap', () => {
  it('returns 1 for identical sets', () => {
    expect(setOverlap(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(setOverlap(['a'], ['b'])).toBe(0);
  });

  it('returns 0.5 for 50% overlap', () => {
    expect(setOverlap(['a', 'b'], ['b', 'c'])).toBeCloseTo(0.5);
  });

  it('returns 1 for two empty arrays', () => {
    expect(setOverlap([], [])).toBe(1);
  });
});
