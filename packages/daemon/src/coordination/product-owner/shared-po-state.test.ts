// packages/daemon/src/coordination/product-owner/shared-po-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SharedPOStateStore,
  markItemDecided,
  markDecisionReviewed,
  addNeedsDiscussionItems,
  addAutonomousDecisions,
  mergeInteractiveDecisions,
} from './shared-po-state.js';
import type { SharedPOState, NeedsDiscussionItem, AutonomousDecisionRecord } from './interactive-schemas.js';

function makeItem(id: string, status: NeedsDiscussionItem['status'] = 'pending'): NeedsDiscussionItem {
  return {
    id,
    sourceType: 'finding',
    sourceRef: 'ref-1',
    contextSummary: 'summary',
    status,
    operatorDecision: null,
    decisionTimestamp: null,
    poCycleId: 'cycle-1',
    createdAt: new Date().toISOString(),
  };
}

function makeDecision(id: string, reviewed = false): AutonomousDecisionRecord {
  return {
    id,
    decisionType: 'finding_approved',
    description: 'desc',
    affectedEntityRef: 'ref-1',
    poCycleId: 'cycle-1',
    reviewed,
    createdAt: new Date().toISOString(),
  };
}

describe('SharedPOStateStore', () => {
  let path: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shared-po-state-'));
    path = join(dir, 'shared-po-state.json');
  });

  it('reads empty state when file is missing', async () => {
    const store = new SharedPOStateStore(path);
    const state = await store.read();
    expect(state.version).toBe(0);
    expect(state.needsDiscussion).toEqual([]);
  });

  it('writes state and increments version', async () => {
    const store = new SharedPOStateStore(path);
    const state = await store.read();
    state.needsDiscussion.push(makeItem('item-1'));
    const result = await store.write(state, 0);
    expect(result.ok).toBe(true);

    const next = await store.read();
    expect(next.version).toBe(1);
    expect(next.needsDiscussion).toHaveLength(1);
  });

  it('detects version conflict', async () => {
    const store = new SharedPOStateStore(path);
    const state = await store.read();
    await store.write(state, 0);

    const result = await store.write(state, 0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('version_conflict');
  });

  it('retries and merges on conflict', async () => {
    const store = new SharedPOStateStore(path, 3);
    const state = await store.read();
    state.needsDiscussion.push(makeItem('item-1'));
    await store.write(state, 0);

    const concurrent = await store.read();
    concurrent.needsDiscussion.push(makeItem('item-2'));

    const result = await store.writeWithRetry(concurrent, 0);
    expect(result.ok).toBe(true);

    const final = await store.read();
    expect(final.needsDiscussion.map((i) => i.id).sort()).toEqual(['item-1', 'item-2']);
  });
});

describe('state helpers', () => {
  let state: SharedPOState;

  beforeEach(() => {
    state = {
      needsDiscussion: [makeItem('item-1')],
      autonomousDecisions: [makeDecision('dec-1')],
      triageQueue: [],
      version: 0,
      lastUpdated: new Date().toISOString(),
    };
  });

  it('markItemDecided updates status and timestamp', () => {
    const updated = markItemDecided(state, 'item-1', 'approve');
    const item = updated.needsDiscussion.find((i) => i.id === 'item-1');
    expect(item?.status).toBe('decided');
    expect(item?.operatorDecision).toBe('approve');
    expect(item?.decisionTimestamp).toBeTruthy();
  });

  it('markDecisionReviewed flips reviewed flag', () => {
    const updated = markDecisionReviewed(state, 'dec-1');
    const decision = updated.autonomousDecisions.find((d) => d.id === 'dec-1');
    expect(decision?.reviewed).toBe(true);
  });

  it('addNeedsDiscussionItems is idempotent', () => {
    const updated = addNeedsDiscussionItems(state, [makeItem('item-1'), makeItem('item-2')]);
    expect(updated.needsDiscussion).toHaveLength(2);
  });

  it('addAutonomousDecisions is idempotent', () => {
    const updated = addAutonomousDecisions(state, [makeDecision('dec-1'), makeDecision('dec-2')]);
    expect(updated.autonomousDecisions).toHaveLength(2);
  });

  it('mergeInteractiveDecisions re-applies decided statuses onto fresh base', () => {
    const incoming: SharedPOState = {
      ...state,
      needsDiscussion: state.needsDiscussion.map((i) =>
        i.id === 'item-1' ? { ...i, status: 'decided' as const, operatorDecision: 'approve' } : i,
      ),
      autonomousDecisions: state.autonomousDecisions.map((d) =>
        d.id === 'dec-1' ? { ...d, reviewed: true } : d,
      ),
    };

    const fresh: SharedPOState = {
      needsDiscussion: [makeItem('item-1'), makeItem('item-2')],
      autonomousDecisions: [makeDecision('dec-1'), makeDecision('dec-2')],
      triageQueue: [],
      version: 5,
      lastUpdated: new Date().toISOString(),
    };

    const merged = mergeInteractiveDecisions(fresh, incoming);
    expect(merged.needsDiscussion.find((i) => i.id === 'item-1')?.status).toBe('decided');
    expect(merged.autonomousDecisions.find((d) => d.id === 'dec-1')?.reviewed).toBe(true);
    expect(merged.needsDiscussion.find((i) => i.id === 'item-2')?.status).toBe('pending');
  });
});
