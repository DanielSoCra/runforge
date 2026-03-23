// src/coordination/terminal-server.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createTerminalServerHandlers,
  type TerminalServerDeps,
} from './terminal-server.js';
import type { Proposal, IdeaSubmission, Batch, WorkerClaim, MergeQueueEntry } from './types.js';

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
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    decidedAt: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TerminalServerDeps> = {}): TerminalServerDeps {
  return {
    loadProposals: vi.fn().mockResolvedValue([]),
    saveProposals: vi.fn().mockResolvedValue(undefined),
    loadIdeas: vi.fn().mockResolvedValue([]),
    saveIdeas: vi.fn().mockResolvedValue(undefined),
    submitIdea: vi.fn().mockResolvedValue({ id: 'idea-1' }),
    getActiveClaims: vi.fn().mockResolvedValue([]),
    getActiveBatch: vi.fn().mockResolvedValue(null),
    getMergeQueueEntries: vi.fn().mockResolvedValue([]),
    pauseDaemon: vi.fn().mockResolvedValue(undefined),
    resumeDaemon: vi.fn().mockResolvedValue(undefined),
    cancelBatch: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    createWorkRequest: vi.fn().mockResolvedValue(42),
    reprioritizeIssue: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...overrides,
  };
}

describe('TerminalServer handlers', () => {
  describe('list_proposals', () => {
    it('returns all proposals when no filter', async () => {
      const proposals = [
        makeProposal({ status: 'proposed' }),
        makeProposal({ status: 'approved' }),
      ];
      const deps = makeDeps({ loadProposals: vi.fn().mockResolvedValue(proposals) });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.list_proposals({});
      expect(result).toHaveLength(2);
    });

    it('filters by status', async () => {
      const proposals = [
        makeProposal({ status: 'proposed' }),
        makeProposal({ status: 'approved' }),
      ];
      const deps = makeDeps({ loadProposals: vi.fn().mockResolvedValue(proposals) });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.list_proposals({ statusFilter: 'proposed' });
      expect(result).toHaveLength(1);
      expect(result[0]!.status).toBe('proposed');
    });
  });

  describe('submit_idea', () => {
    it('delegates to submitIdea dep', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.submit_idea({ description: 'Add dark mode' });
      expect(deps.submitIdea).toHaveBeenCalledWith('Add dark mode');
      expect(result).toHaveProperty('id');
    });
  });

  describe('approve_proposal', () => {
    it('transitions proposal to approved and creates work request', async () => {
      const proposal = makeProposal({ status: 'proposed' });
      const deps = makeDeps({
        loadProposals: vi.fn().mockResolvedValue([proposal]),
        createWorkRequest: vi.fn().mockResolvedValue(42),
      });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.approve_proposal({
        proposalId: proposal.id,
        decisionNotes: 'Looks good',
      });

      expect(result.issueNumber).toBe(42);
      expect(deps.saveProposals).toHaveBeenCalled();
      const saved = (deps.saveProposals as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Proposal[];
      expect(saved[0]!.status).toBe('approved');
      expect(saved[0]!.decisionNotes).toBe('Looks good');
    });

    it('returns error for non-existent proposal', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      await expect(
        handlers.approve_proposal({ proposalId: 'nonexistent' }),
      ).rejects.toThrow('not_found');
    });

    it('returns error for already-decided proposal', async () => {
      const proposal = makeProposal({ status: 'approved' });
      const deps = makeDeps({
        loadProposals: vi.fn().mockResolvedValue([proposal]),
      });
      const handlers = createTerminalServerHandlers(deps);

      await expect(
        handlers.approve_proposal({ proposalId: proposal.id }),
      ).rejects.toThrow('invalid_state');
    });
  });

  describe('reject_proposal', () => {
    it('transitions proposal to rejected', async () => {
      const proposal = makeProposal({ status: 'proposed' });
      const deps = makeDeps({
        loadProposals: vi.fn().mockResolvedValue([proposal]),
      });
      const handlers = createTerminalServerHandlers(deps);

      await handlers.reject_proposal({
        proposalId: proposal.id,
        decisionNotes: 'Not now',
      });

      expect(deps.saveProposals).toHaveBeenCalled();
      const saved = (deps.saveProposals as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Proposal[];
      expect(saved[0]!.status).toBe('rejected');
    });
  });

  describe('get_briefing', () => {
    it('returns briefing summary', async () => {
      const deps = makeDeps({
        getActiveClaims: vi.fn().mockResolvedValue([
          { id: '1', agentType: 'worker', status: 'in_progress' },
        ]),
        getMergeQueueEntries: vi.fn().mockResolvedValue([
          { id: '1', status: 'queued' },
        ]),
        getActiveBatch: vi.fn().mockResolvedValue({
          id: 'b1', status: 'active', items: [],
        }),
      });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_briefing();
      expect(result).toHaveProperty('activeWorkers');
      expect(result).toHaveProperty('mergeQueueDepth');
      expect(result).toHaveProperty('batchStatus');
      expect(result).toHaveProperty('recentInferenceDecisions');
    });

    it('includes recent inference decisions when provider available', async () => {
      const decisions = [
        {
          decisionType: 'stuck_detection' as const,
          chosenAction: 'stuck',
          confidence: 0.8,
          rationale: 'No progress',
          timestamp: new Date().toISOString(),
          degraded: false,
        },
      ];
      const deps = makeDeps({
        getRecentInferenceDecisions: vi.fn().mockResolvedValue(decisions),
      });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_briefing();
      expect(result.recentInferenceDecisions).toHaveLength(1);
      expect(result.recentInferenceDecisions[0]!.chosenAction).toBe('stuck');
    });

    it('returns empty array when inference provider not available', async () => {
      const deps = makeDeps(); // no getRecentInferenceDecisions
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_briefing();
      expect(result.recentInferenceDecisions).toEqual([]);
    });
  });

  describe('get_active_work', () => {
    it('returns active claims', async () => {
      const claims = [{ id: '1', agentType: 'worker', status: 'in_progress', issueNumber: 42 }];
      const deps = makeDeps({
        getActiveClaims: vi.fn().mockResolvedValue(claims),
      });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_active_work();
      expect(result).toHaveLength(1);
    });
  });

  describe('get_batch_plan', () => {
    it('returns null when no active batch', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_batch_plan();
      expect(result).toBeNull();
    });

    it('returns active batch with items', async () => {
      const batch: Batch = {
        id: 'b1',
        status: 'active',
        targetWorkerCount: 3,
        budgetEstimate: 100,
        items: [{ id: 'i1', issueNumber: 1, status: 'pending', dependencies: [] }],
        createdAt: new Date().toISOString(),
        activatedAt: new Date().toISOString(),
        completedAt: null,
      };
      const deps = makeDeps({ getActiveBatch: vi.fn().mockResolvedValue(batch) });
      const handlers = createTerminalServerHandlers(deps);

      const result = await handlers.get_batch_plan();
      expect(result).toBeDefined();
      expect(result!.id).toBe('b1');
    });
  });

  describe('pause_daemon / resume_daemon', () => {
    it('delegates pause to dep', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      await handlers.pause_daemon();
      expect(deps.pauseDaemon).toHaveBeenCalled();
    });

    it('delegates resume to dep', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      await handlers.resume_daemon();
      expect(deps.resumeDaemon).toHaveBeenCalled();
    });
  });

  describe('cancel_batch', () => {
    it('delegates to cancelBatch dep', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      await handlers.cancel_batch({});
      expect(deps.cancelBatch).toHaveBeenCalled();
    });
  });

  describe('reprioritize_issue', () => {
    it('delegates to reprioritizeIssue dep', async () => {
      const deps = makeDeps();
      const handlers = createTerminalServerHandlers(deps);

      await handlers.reprioritize_issue({ issueNumber: 42, priority: 'higher' });
      expect(deps.reprioritizeIssue).toHaveBeenCalledWith(42, 'higher');
    });
  });
});
