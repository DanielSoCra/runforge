// src/coordination/po-agent.ts — Scheduled PO sessions with proposal sweep and idea debounce
import { randomUUID } from 'crypto';
import type { Proposal, IdeaSubmission } from './types.js';

export interface POAgentConfig {
  intervalMs: number;
  debounceMs: number;
}

export interface POAgentDeps {
  loadProposals: () => Promise<Proposal[]>;
  saveProposals: (proposals: Proposal[]) => Promise<void>;
  loadIdeas: () => Promise<IdeaSubmission[]>;
  saveIdeas: (ideas: IdeaSubmission[]) => Promise<void>;
  spawnPOSession: () => Promise<void>;
}

export interface POAgent {
  start(): () => void;
  submitIdea(submittedBy: string, description: string): Promise<IdeaSubmission>;
}

export function createPOAgent(deps: POAgentDeps, config: POAgentConfig): POAgent {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  async function sweepExpiredProposals(): Promise<void> {
    const proposals = await deps.loadProposals();
    const now = Date.now();
    let changed = false;

    for (const proposal of proposals) {
      if (proposal.status !== 'proposed') continue;
      if (new Date(proposal.expiresAt).getTime() <= now) {
        proposal.status = 'expired';
        changed = true;
      }
    }

    if (changed) {
      await deps.saveProposals(proposals);
    }
  }

  async function runCycle(): Promise<void> {
    await sweepExpiredProposals();
    await deps.spawnPOSession();
  }

  function start(): () => void {
    intervalTimer = setInterval(() => {
      runCycle().catch(() => {
        // Cycle errors are swallowed — next cycle will retry
      });
    }, config.intervalMs);

    return () => {
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  }

  async function submitIdea(submittedBy: string, description: string): Promise<IdeaSubmission> {
    const idea: IdeaSubmission = {
      id: randomUUID(),
      submittedBy,
      description,
      status: 'pending',
      proposalId: null,
      createdAt: new Date().toISOString(),
    };

    const ideas = await deps.loadIdeas();
    ideas.push(idea);
    await deps.saveIdeas(ideas);

    // Debounced PO evaluation — at most once per debounce window
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCycle().catch(() => {});
    }, config.debounceMs);

    return idea;
  }

  return { start, submitIdea };
}
