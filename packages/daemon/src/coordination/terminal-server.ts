// src/coordination/terminal-server.ts — MCP server with coordination tools
import type { Proposal, IdeaSubmission, Batch, WorkerClaim, MergeQueueEntry } from './types.js';
import type { Result } from '../lib/result.js';

// --- Handler types (testable without MCP transport) ---

export interface TerminalServerDeps {
  loadProposals: () => Promise<Proposal[]>;
  saveProposals: (proposals: Proposal[]) => Promise<void>;
  loadIdeas: () => Promise<IdeaSubmission[]>;
  saveIdeas: (ideas: IdeaSubmission[]) => Promise<void>;
  submitIdea: (description: string) => Promise<{ id: string }>;
  getActiveClaims: () => Promise<WorkerClaim[]>;
  getActiveBatch: () => Promise<Batch | null>;
  getMergeQueueEntries: () => Promise<MergeQueueEntry[]>;
  pauseDaemon: () => Promise<void>;
  resumeDaemon: () => Promise<void>;
  cancelBatch: (batchId?: string) => Promise<Result<void>>;
  createWorkRequest: (proposal: Proposal) => Promise<number>;
  reprioritizeIssue: (issueNumber: number, priority: string) => Promise<Result<void>>;
}

export interface Briefing {
  activeWorkers: number;
  mergeQueueDepth: number;
  batchStatus: string | null;
}

export class TerminalServerError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state' | 'validation_error',
    message: string,
    public readonly operation: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TerminalServerError';
  }
}

export interface TerminalServerHandlers {
  list_proposals(params: { statusFilter?: string }): Promise<Proposal[]>;
  submit_idea(params: { description: string }): Promise<{ id: string }>;
  approve_proposal(params: { proposalId: string; decisionNotes?: string }): Promise<{ issueNumber: number }>;
  reject_proposal(params: { proposalId: string; decisionNotes?: string }): Promise<void>;
  get_briefing(): Promise<Briefing>;
  get_active_work(): Promise<WorkerClaim[]>;
  get_batch_plan(): Promise<Batch | null>;
  pause_daemon(): Promise<void>;
  resume_daemon(): Promise<void>;
  cancel_batch(params: { batchId?: string }): Promise<void>;
  reprioritize_issue(params: { issueNumber: number; priority: string }): Promise<void>;
}

export function createTerminalServerHandlers(deps: TerminalServerDeps): TerminalServerHandlers {
  return {
    async list_proposals({ statusFilter }) {
      const proposals = await deps.loadProposals();
      if (statusFilter) {
        return proposals.filter((p) => p.status === statusFilter);
      }
      return proposals;
    },

    async submit_idea({ description }) {
      return deps.submitIdea(description);
    },

    async approve_proposal({ proposalId, decisionNotes }) {
      const proposals = await deps.loadProposals();
      const proposal = proposals.find((p) => p.id === proposalId);

      if (!proposal) {
        throw new TerminalServerError('not_found', `Proposal ${proposalId} not found`, 'approve_proposal');
      }

      if (proposal.status !== 'proposed') {
        throw new TerminalServerError(
          'invalid_state',
          `Proposal ${proposalId} is already ${proposal.status}`,
          'approve_proposal',
        );
      }

      proposal.status = 'approved';
      proposal.decisionNotes = decisionNotes ?? null;
      proposal.decidedAt = new Date().toISOString();

      const issueNumber = await deps.createWorkRequest(proposal);
      proposal.issueNumber = issueNumber;

      await deps.saveProposals(proposals);

      return { issueNumber };
    },

    async reject_proposal({ proposalId, decisionNotes }) {
      const proposals = await deps.loadProposals();
      const proposal = proposals.find((p) => p.id === proposalId);

      if (!proposal) {
        throw new TerminalServerError('not_found', `Proposal ${proposalId} not found`, 'reject_proposal');
      }

      if (proposal.status !== 'proposed') {
        throw new TerminalServerError(
          'invalid_state',
          `Proposal ${proposalId} is already ${proposal.status}`,
          'reject_proposal',
        );
      }

      proposal.status = 'rejected';
      proposal.decisionNotes = decisionNotes ?? null;
      proposal.decidedAt = new Date().toISOString();

      await deps.saveProposals(proposals);
    },

    async get_briefing() {
      const claims = await deps.getActiveClaims();
      const mergeEntries = await deps.getMergeQueueEntries();
      const batch = await deps.getActiveBatch();

      return {
        activeWorkers: claims.length,
        mergeQueueDepth: mergeEntries.length,
        batchStatus: batch?.status ?? null,
      };
    },

    async get_active_work() {
      return deps.getActiveClaims();
    },

    async get_batch_plan() {
      return deps.getActiveBatch();
    },

    async pause_daemon() {
      await deps.pauseDaemon();
    },

    async resume_daemon() {
      await deps.resumeDaemon();
    },

    async cancel_batch({ batchId }) {
      const result = await deps.cancelBatch(batchId);
      if (!result.ok) {
        throw new TerminalServerError('not_found', result.error.message, 'cancel_batch');
      }
    },

    async reprioritize_issue({ issueNumber, priority }) {
      const result = await deps.reprioritizeIssue(issueNumber, priority);
      if (!result.ok) {
        throw new TerminalServerError('not_found', result.error.message, 'reprioritize_issue');
      }
    },
  };
}
