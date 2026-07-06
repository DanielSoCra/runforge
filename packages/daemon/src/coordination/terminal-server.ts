// src/coordination/terminal-server.ts — MCP server with coordination tools
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Proposal, IdeaSubmission, Batch, WorkerClaim, MergeQueueEntry, InferenceDecision } from './types.js';
import { ProposalStatusSchema } from './types.js';
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
  getRecentInferenceDecisions?: (count: number) => Promise<InferenceDecision[]>;
}

export interface Briefing {
  activeWorkers: number;
  mergeQueueDepth: number;
  batchStatus: string | null;
  recentInferenceDecisions: InferenceDecision[];
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

      // Note: if createWorkRequest succeeds but saveProposals fails, the GitHub
      // issue is created but the proposal status is not persisted. This is a known
      // limitation of JSON file persistence (no transactions). On next load the
      // proposal will still appear as 'proposed'. The operator can re-approve.
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
      const recentInferenceDecisions = deps.getRecentInferenceDecisions
        ? await deps.getRecentInferenceDecisions(5)
        : [];

      return {
        activeWorkers: claims.length,
        mergeQueueDepth: mergeEntries.length,
        batchStatus: batch?.status ?? null,
        recentInferenceDecisions,
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

// --- MCP Server wiring ---

function mcpTextResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Creates and starts an MCP server over stdio transport with all coordination tools. */
export async function startTerminalServer(deps: TerminalServerDeps): Promise<void> {
  const handlers = createTerminalServerHandlers(deps);
  const server = new McpServer({ name: 'runforge-coordination', version: '1.0.0' });

  server.tool('list_proposals', { statusFilter: ProposalStatusSchema.optional() }, async (params) => {
    const result = await handlers.list_proposals({ statusFilter: params.statusFilter });
    return mcpTextResult(result);
  });

  server.tool('submit_idea', { description: z.string().min(1) }, async (params) => {
    const result = await handlers.submit_idea({ description: params.description });
    return mcpTextResult(result);
  });

  server.tool('approve_proposal', { proposalId: z.string().uuid(), decisionNotes: z.string().optional() }, async (params) => {
    const result = await handlers.approve_proposal({ proposalId: params.proposalId, decisionNotes: params.decisionNotes });
    return mcpTextResult(result);
  });

  server.tool('reject_proposal', { proposalId: z.string().uuid(), decisionNotes: z.string().optional() }, async (params) => {
    await handlers.reject_proposal({ proposalId: params.proposalId, decisionNotes: params.decisionNotes });
    return mcpTextResult({ ok: true });
  });

  server.tool('get_briefing', {}, async () => {
    const result = await handlers.get_briefing();
    return mcpTextResult(result);
  });

  server.tool('get_active_work', {}, async () => {
    const result = await handlers.get_active_work();
    return mcpTextResult(result);
  });

  server.tool('get_batch_plan', {}, async () => {
    const result = await handlers.get_batch_plan();
    return mcpTextResult(result);
  });

  server.tool('pause_daemon', {}, async () => {
    await handlers.pause_daemon();
    return mcpTextResult({ ok: true });
  });

  server.tool('resume_daemon', {}, async () => {
    await handlers.resume_daemon();
    return mcpTextResult({ ok: true });
  });

  server.tool('cancel_batch', { batchId: z.string().uuid().optional() }, async (params) => {
    await handlers.cancel_batch({ batchId: params.batchId });
    return mcpTextResult({ ok: true });
  });

  server.tool('reprioritize_issue', { issueNumber: z.number().int(), priority: z.string() }, async (params) => {
    await handlers.reprioritize_issue({ issueNumber: params.issueNumber, priority: params.priority });
    return mcpTextResult({ ok: true });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
