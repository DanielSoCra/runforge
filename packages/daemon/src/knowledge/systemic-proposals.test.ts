// src/knowledge/systemic-proposals.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore } from './knowledge-store.js';
import { DEFAULT_POLICIES } from './policy-registry.js';
import {
  detectSystemicProposals,
  loadProposals,
  approveProposal,
  rejectProposal,
} from './systemic-proposals.js';

let dir: string;
let store: KnowledgeStore;
let proposalsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'systemic-test-'));
  store = new KnowledgeStore(join(dir, 'knowledge.jsonl'), DEFAULT_POLICIES);
  proposalsDir = join(dir, 'systemic-proposals');
  await mkdir(proposalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('systemic-proposals', () => {
  it('detects proposals when root-cause tag count exceeds threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await store.storeRecord(
        [{ artifactPatterns: [`src/${i}/**`], description: `Leak issue ${i}`, rootCauseTag: 'memory-leak' }],
        `issue-${i}`, 'autonomous', 'technical_pitfall',
      );
    }
    const proposals = await detectSystemicProposals(store, proposalsDir, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.rootCauseTag).toBe('memory-leak');
    expect(proposals[0]!.relatedRecordIds).toHaveLength(3);
    expect(proposals[0]!.status).toBe('pending');
  });

  it('does not detect proposals below threshold', async () => {
    for (let i = 0; i < 2; i++) {
      await store.storeRecord(
        [{ artifactPatterns: [`src/${i}/**`], description: `Issue ${i}`, rootCauseTag: 'race-cond' }],
        `issue-${i}`, 'autonomous', 'technical_pitfall',
      );
    }
    const proposals = await detectSystemicProposals(store, proposalsDir, 3);
    expect(proposals).toHaveLength(0);
  });

  it('skips tags with active cooldown', async () => {
    for (let i = 0; i < 3; i++) {
      await store.storeRecord(
        [{ artifactPatterns: [`src/${i}/**`], description: `Issue ${i}`, rootCauseTag: 'cool-tag' }],
        `issue-${i}`, 'autonomous', 'technical_pitfall',
      );
    }
    // First detection creates proposals
    const first = await detectSystemicProposals(store, proposalsDir, 3);
    expect(first).toHaveLength(1);

    // Reject the proposal (sets cooldown)
    await rejectProposal(proposalsDir, first[0]!.id, 30);

    // Second detection should skip due to cooldown
    const second = await detectSystemicProposals(store, proposalsDir, 3);
    expect(second).toHaveLength(0);
  });

  it('loadProposals returns all pending proposals', async () => {
    for (let i = 0; i < 3; i++) {
      await store.storeRecord(
        [{ artifactPatterns: [`src/${i}/**`], description: `Issue ${i}`, rootCauseTag: 'tag-1' }],
        `issue-${i}`, 'autonomous', 'technical_pitfall',
      );
    }
    await detectSystemicProposals(store, proposalsDir, 3);
    const pending = await loadProposals(proposalsDir, 'pending');
    expect(pending).toHaveLength(1);
  });

  it('approveProposal transitions status to approved', async () => {
    for (let i = 0; i < 3; i++) {
      await store.storeRecord(
        [{ artifactPatterns: [`src/${i}/**`], description: `Issue ${i}`, rootCauseTag: 'approve-tag' }],
        `issue-${i}`, 'autonomous', 'technical_pitfall',
      );
    }
    const proposals = await detectSystemicProposals(store, proposalsDir, 3);
    await approveProposal(proposalsDir, proposals[0]!.id);
    const pending = await loadProposals(proposalsDir, 'pending');
    expect(pending).toHaveLength(0);
    const approved = await loadProposals(proposalsDir, 'approved');
    expect(approved).toHaveLength(1);
  });
});
