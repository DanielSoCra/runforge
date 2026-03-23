// src/knowledge/candidate-queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore } from './knowledge-store.js';
import { DEFAULT_POLICIES } from './policy-registry.js';
import { getCandidates, approveCandidate, rejectCandidate, archiveExpiredCandidates } from './candidate-queue.js';

let dir: string;
let store: KnowledgeStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'candidate-queue-test-'));
  store = new KnowledgeStore(join(dir, 'knowledge.jsonl'), DEFAULT_POLICIES);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('candidate-queue', () => {
  it('getCandidates returns only candidate records', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Active one' }],
      'issue-1', 'autonomous', 'technical_pitfall',
    );
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Candidate one' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    const candidates = await getCandidates(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.lifecycleStatus).toBe('candidate');
  });

  it('approveCandidate transitions to active', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'To approve' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    const candidates = await getCandidates(store);
    await approveCandidate(store, candidates[0]!.id);

    const records = await store.matchRecords(['src/foo.ts'], 'implementation');
    expect(records).toHaveLength(1);
    expect(records[0]!.lifecycleStatus).toBe('active');
  });

  it('rejectCandidate transitions to archived', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'To reject' }],
      'retro-1', 'retrospective-po', 'business_observation',
    );
    const candidates = await getCandidates(store);
    await rejectCandidate(store, candidates[0]!.id);

    const after = await getCandidates(store);
    expect(after).toHaveLength(0);
    // Also not matchable
    const records = await store.matchRecords(['src/foo.ts'], 'product_ownership');
    expect(records).toHaveLength(0);
  });

  it('archiveExpiredCandidates archives candidates older than timeout', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Old candidate' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    // Use timeoutDays=-1 to treat everything as expired
    const archived = await archiveExpiredCandidates(store, -1);
    expect(archived).toHaveLength(1);
    const candidates = await getCandidates(store);
    expect(candidates).toHaveLength(0);
  });

  it('approveCandidate rejects if record is no longer a candidate', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Will be archived first' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    const candidates = await getCandidates(store);
    const id = candidates[0]!.id;

    // Simulate auto-archival winning the race
    await rejectCandidate(store, id);

    // Approval should fail — record is archived, not candidate
    await expect(approveCandidate(store, id)).rejects.toThrow(/expected status 'candidate'/);
  });

  it('archiveExpiredCandidates skips already-approved candidates and continues', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'First candidate' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Second candidate' }],
      'retro-2', 'retrospective-tech-lead', 'technical_pitfall',
    );
    const candidates = await getCandidates(store);
    expect(candidates).toHaveLength(2);

    // Approve the first candidate (simulates interleaved approval)
    await approveCandidate(store, candidates[0]!.id);

    // Archive expired should skip the approved one and still archive the second
    const archived = await archiveExpiredCandidates(store, -1);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toBe(candidates[1]!.id);
  });

  it('archiveExpiredCandidates does not archive fresh candidates', async () => {
    await store.storeRecord(
      [{ artifactPatterns: ['src/**'], description: 'Fresh candidate' }],
      'retro-1', 'retrospective-tech-lead', 'technical_pitfall',
    );
    const archived = await archiveExpiredCandidates(store, 14);
    expect(archived).toHaveLength(0);
  });
});
