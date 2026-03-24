// src/coordination/product-owner/proposal-generator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { POProposalStore, setOverlap } from './proposal-generator.js';
import type { RawProposal } from './schemas.js';

function makeRawProposal(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    title: 'Advance FUNC-AC-LEARNING to L2',
    rationale: 'Pipeline gap — no L2 architecture spec',
    proposalType: 'spec_advancement',
    relatedRefs: ['FUNC-AC-LEARNING'],
    estimatedScope: 'medium',
    ...overrides,
  };
}

let tmpDir: string;
let store: POProposalStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'po-store-'));
  store = new POProposalStore(join(tmpDir, 'proposals'));
  await store.init();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('POProposalStore — save and load', () => {
  it('saves and loads a proposal', async () => {
    const id = await store.saveRawProposal(makeRawProposal());
    expect(id).toBeDefined();
    const loaded = await store.loadProposal(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Advance FUNC-AC-LEARNING to L2');
    expect(loaded!.status).toBe('proposed');
  });

  it('returns null for non-existent proposal', async () => {
    const loaded = await store.loadProposal('non-existent-id');
    expect(loaded).toBeNull();
  });

  it('loads all proposals', async () => {
    await store.saveRawProposal(makeRawProposal());
    await store.saveRawProposal(makeRawProposal({ title: 'Second' }));
    const all = await store.loadAllProposals();
    expect(all).toHaveLength(2);
  });

  it('loads only active proposals', async () => {
    const id1 = await store.saveRawProposal(makeRawProposal());
    const id2 = await store.saveRawProposal(makeRawProposal({ title: 'Second' }));
    // Expire one
    const p = await store.loadProposal(id2);
    await store.updateStatus(id2, 'expired');
    const active = await store.loadActiveProposals();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(id1);
  });
});

describe('POProposalStore — status transitions', () => {
  it('transitions proposed to approved', async () => {
    const id = await store.saveRawProposal(makeRawProposal());
    await store.updateStatus(id, 'approved');
    const loaded = await store.loadProposal(id);
    expect(loaded!.status).toBe('approved');
  });

  it('transitions proposed to rejected', async () => {
    const id = await store.saveRawProposal(makeRawProposal());
    await store.updateStatus(id, 'rejected');
    const loaded = await store.loadProposal(id);
    expect(loaded!.status).toBe('rejected');
  });

  it('transitions proposed to expired', async () => {
    const id = await store.saveRawProposal(makeRawProposal());
    await store.updateStatus(id, 'expired');
    const loaded = await store.loadProposal(id);
    expect(loaded!.status).toBe('expired');
  });
});

describe('POProposalStore — deduplication', () => {
  it('finds duplicate with same type and overlapping refs', async () => {
    await store.saveRawProposal(makeRawProposal({
      proposalType: 'spec_advancement',
      relatedRefs: ['FUNC-AC-LEARNING', 'FUNC-AC-PIPELINE'],
    }));
    const dup = await store.findDuplicate('spec_advancement', ['FUNC-AC-LEARNING', 'FUNC-AC-PIPELINE']);
    expect(dup).toBeDefined();
  });

  it('returns undefined when no overlap', async () => {
    await store.saveRawProposal(makeRawProposal({
      proposalType: 'spec_advancement',
      relatedRefs: ['FUNC-AC-LEARNING'],
    }));
    const dup = await store.findDuplicate('spec_advancement', ['FUNC-AC-QUALITY']);
    expect(dup).toBeUndefined();
  });

  it('returns undefined when different type', async () => {
    await store.saveRawProposal(makeRawProposal({
      proposalType: 'spec_advancement',
      relatedRefs: ['FUNC-AC-LEARNING'],
    }));
    const dup = await store.findDuplicate('stale_investigation', ['FUNC-AC-LEARNING']);
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

  it('returns 1 for two empty arrays', () => {
    expect(setOverlap([], [])).toBe(1);
  });
});
