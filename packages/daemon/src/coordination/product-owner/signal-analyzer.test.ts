// src/coordination/product-owner/signal-analyzer.test.ts
import { describe, it, expect } from 'vitest';
import { assembleSignalSnapshot, computeSpecGaps, type SnapshotDeps, type SnapshotConfig } from './signal-analyzer.js';

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    getSpecPipeline: async () => [
      { specId: 'FUNC-AC-LEARNING', hasL1: true, hasL2: false, hasL3: false, isImplemented: false },
    ],
    getDeliverySummary: async () => [
      { repo: 'auto-claude', passRate: 0.85, completionCount: 12 },
    ],
    getBacklog: async () => [
      { issueNumber: 42, title: 'Fix bug', labels: ['bug'], ageDays: 3, isStale: false },
    ],
    getActiveProposals: async () => [],
    getProposalHistory: async () => [],
    getIdeaInbox: async () => [],
    getFindingsAwaitingApproval: async () => [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SnapshotConfig> = {}): SnapshotConfig {
  return {
    maxBacklogEntries: 50,
    maxProposalEntries: 20,
    maxIdeaEntries: 10,
    maxDefaultEntries: 50,
    maxFindingsEntries: 5,
    ...overrides,
  };
}

describe('assembleSignalSnapshot', () => {
  it('assembles snapshot from all sources', async () => {
    const snapshot = await assembleSignalSnapshot(makeDeps(), makeConfig());
    expect(snapshot.specPipeline).toHaveLength(1);
    expect(snapshot.deliverySummary).toHaveLength(1);
    expect(snapshot.backlog).toHaveLength(1);
    expect(snapshot.missingSources).toEqual([]);
    expect(snapshot.cycleTimestamp).toBeDefined();
  });

  it('handles partial failures gracefully', async () => {
    const deps = makeDeps({
      getDeliverySummary: async () => { throw new Error('DB down'); },
      getBacklog: async () => { throw new Error('API error'); },
    });
    const snapshot = await assembleSignalSnapshot(deps, makeConfig());
    expect(snapshot.specPipeline).toHaveLength(1);
    expect(snapshot.deliverySummary).toEqual([]);
    expect(snapshot.backlog).toEqual([]);
    expect(snapshot.missingSources).toContain('delivery_summary');
    expect(snapshot.missingSources).toContain('backlog');
  });

  it('caps entries per section', async () => {
    const deps = makeDeps({
      getBacklog: async () => Array.from({ length: 100 }, (_, i) => ({
        issueNumber: i, title: `Issue ${i}`, labels: [], ageDays: 1, isStale: false,
      })),
    });
    const snapshot = await assembleSignalSnapshot(deps, makeConfig({ maxBacklogEntries: 10 }));
    expect(snapshot.backlog).toHaveLength(10);
    expect(snapshot.missingSources).toContain('backlog_truncated');
  });

  it('uses per-section caps for ideas', async () => {
    const deps = makeDeps({
      getIdeaInbox: async () => Array.from({ length: 20 }, (_, i) => ({
        id: `i${i}`, content: `Idea ${i}`, submittedAt: new Date().toISOString(),
      })),
    });
    const snapshot = await assembleSignalSnapshot(deps, makeConfig({ maxIdeaEntries: 5 }));
    expect(snapshot.ideaInbox).toHaveLength(5);
    expect(snapshot.missingSources).toContain('idea_inbox_truncated');
  });

  it('includes ideas in snapshot', async () => {
    const deps = makeDeps({
      getIdeaInbox: async () => [
        { id: 'i1', content: 'Add caching', submittedAt: new Date().toISOString() },
      ],
    });
    const snapshot = await assembleSignalSnapshot(deps, makeConfig());
    expect(snapshot.ideaInbox).toHaveLength(1);
  });
});

describe('computeSpecGaps', () => {
  it('identifies specs with missing layers', () => {
    const traceabilityContent = `
L0-AC-VISION:
  children: [FUNC-AC-LEARNING, FUNC-AC-PIPELINE]
  status: draft

FUNC-AC-LEARNING:
  children: []
  status: draft

FUNC-AC-PIPELINE:
  children: [ARCH-AC-CONTROL-PLANE]
  status: draft

ARCH-AC-CONTROL-PLANE:
  parent: FUNC-AC-PIPELINE
  children: [STACK-AC-CONTROL-PLANE]
  status: draft

STACK-AC-CONTROL-PLANE:
  parent: ARCH-AC-CONTROL-PLANE
  children: []
  code_paths:
    - packages/daemon/src/control-plane/
  status: draft
`;
    const gaps = computeSpecGaps(traceabilityContent);
    const learning = gaps.find(g => g.specId === 'FUNC-AC-LEARNING');
    expect(learning).toBeDefined();
    expect(learning!.hasL1).toBe(true);
    expect(learning!.hasL2).toBe(false);
    expect(learning!.hasL3).toBe(false);
    expect(learning!.isImplemented).toBe(false);

    const pipeline = gaps.find(g => g.specId === 'FUNC-AC-PIPELINE');
    expect(pipeline).toBeDefined();
    expect(pipeline!.hasL2).toBe(true);
    expect(pipeline!.hasL3).toBe(true);
    expect(pipeline!.isImplemented).toBe(true);
  });

  it('returns empty array for empty content', () => {
    expect(computeSpecGaps('')).toEqual([]);
  });

  it('resolves the concierge L0 tree symmetrically with the auto-claude L0 tree', () => {
    // Proves spec resolution is L0-agnostic. Either the AC tree or the
    // concierge tree must walk equivalently when the operator queries gaps.
    const traceabilityContent = `
L0-CONCIERGE-VISION:
  children: [FUNC-CONCIERGE-CORE, FUNC-CONCIERGE-AWARENESS]
  status: draft

FUNC-CONCIERGE-CORE:
  children: [ARCH-CONCIERGE-RUNTIME]
  status: draft

FUNC-CONCIERGE-AWARENESS:
  children: []
  status: draft

ARCH-CONCIERGE-RUNTIME:
  parent: FUNC-CONCIERGE-CORE
  children: [STACK-CONCIERGE-NODE]
  status: draft

STACK-CONCIERGE-NODE:
  parent: ARCH-CONCIERGE-RUNTIME
  children: []
  code_paths:
    - packages/concierge/
  status: draft
`;
    const gaps = computeSpecGaps(traceabilityContent);
    const core = gaps.find(g => g.specId === 'FUNC-CONCIERGE-CORE');
    expect(core).toBeDefined();
    expect(core!.hasL2).toBe(true);
    expect(core!.hasL3).toBe(true);
    expect(core!.isImplemented).toBe(true);

    const awareness = gaps.find(g => g.specId === 'FUNC-CONCIERGE-AWARENESS');
    expect(awareness).toBeDefined();
    expect(awareness!.hasL2).toBe(false);
  });
});
