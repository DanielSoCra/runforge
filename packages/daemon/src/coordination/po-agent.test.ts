// src/coordination/po-agent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPOAgent, type POAgentDeps, type POAgentConfig } from './po-agent.js';
import type { Proposal, IdeaSubmission } from './types.js';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: crypto.randomUUID(),
    title: 'Test Proposal',
    rationale: 'Test rationale',
    scope: 'small',
    status: 'proposed',
    relatedSpecs: [],
    relatedIssues: [],
    issueNumber: null,
    approvedBy: null,
    decisionNotes: null,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), // tomorrow
    createdAt: new Date().toISOString(),
    decidedAt: null,
    ...overrides,
  };
}

function makeIdea(overrides: Partial<IdeaSubmission> = {}): IdeaSubmission {
  return {
    id: crypto.randomUUID(),
    submittedBy: 'operator',
    description: 'Test idea',
    status: 'pending',
    proposalId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<POAgentConfig> = {}): POAgentConfig {
  return {
    intervalMs: 3600000,
    debounceMs: 60000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<POAgentDeps> = {}): POAgentDeps {
  return {
    loadProposals: vi.fn().mockResolvedValue([]),
    saveProposals: vi.fn().mockResolvedValue(undefined),
    loadIdeas: vi.fn().mockResolvedValue([]),
    saveIdeas: vi.fn().mockResolvedValue(undefined),
    spawnPOSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('POAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs PO session on scheduled interval', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.spawnPOSession).toHaveBeenCalledTimes(1);
    stop();
  });

  it('sweeps expired proposals on each cycle', async () => {
    const expired = makeProposal({
      status: 'proposed',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const valid = makeProposal({
      status: 'proposed',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const deps = makeDeps({
      loadProposals: vi.fn().mockResolvedValue([expired, valid]),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(deps.saveProposals).toHaveBeenCalled();
    const savedProposals = (deps.saveProposals as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Proposal[];
    const expiredProposal = savedProposals.find(p => p.id === expired.id);
    expect(expiredProposal?.status).toBe('expired');
    // Valid proposal unchanged
    const validProposal = savedProposals.find(p => p.id === valid.id);
    expect(validProposal?.status).toBe('proposed');
    stop();
  });

  it('submitIdea stores idea and triggers debounced PO evaluation', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 60000, debounceMs: 500 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    await agent.submitIdea('operator', 'Add dark mode');

    expect(deps.saveIdeas).toHaveBeenCalled();

    // Wait for debounce
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.spawnPOSession).toHaveBeenCalledTimes(1);

    stop();
  });

  it('debounces multiple ideas within debounce window', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 60000, debounceMs: 500 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    await agent.submitIdea('operator', 'Idea 1');
    await vi.advanceTimersByTimeAsync(200);
    await agent.submitIdea('operator', 'Idea 2');
    await vi.advanceTimersByTimeAsync(600);

    // Only one PO session spawned despite two ideas
    expect(deps.spawnPOSession).toHaveBeenCalledTimes(1);

    stop();
  });

  it('stop() clears interval and debounce timer', async () => {
    const deps = makeDeps();
    const config = makeConfig({ intervalMs: 1000 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    stop();

    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.spawnPOSession).not.toHaveBeenCalled();
  });

  it('does not sweep already-decided proposals', async () => {
    const approved = makeProposal({
      status: 'approved',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const deps = makeDeps({
      loadProposals: vi.fn().mockResolvedValue([approved]),
    });
    const config = makeConfig({ intervalMs: 1000 });
    const agent = createPOAgent(deps, config);
    const stop = agent.start();

    await vi.advanceTimersByTimeAsync(1100);

    if ((deps.saveProposals as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      const savedProposals = (deps.saveProposals as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Proposal[];
      const p = savedProposals.find(p => p.id === approved.id);
      expect(p?.status).toBe('approved'); // unchanged
    }
    stop();
  });
});
