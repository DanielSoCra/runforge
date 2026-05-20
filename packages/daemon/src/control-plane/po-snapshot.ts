// src/control-plane/po-snapshot.ts
// Real data-source wiring for Product Owner SignalSnapshot assembly.
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { assembleSignalSnapshot, computeSpecGaps, type SnapshotConfig } from '../coordination/product-owner/signal-analyzer.js';
import type { FindingAwaitingApproval, SignalSnapshot } from '../coordination/product-owner/schemas.js';
import type { IdeaSubmission, Proposal } from '../coordination/types.js';
import { readJsonSafe } from '../lib/json-store.js';
import type { RunState } from '../types.js';
import { isComplete } from './fsm.js';

type GitHubLabel = string | { name?: string | null };

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  created_at: string;
  labels: GitHubLabel[];
  pull_request?: unknown;
}

interface GitHubIssuesApi {
  listForRepo(params: {
    owner: string;
    repo: string;
    labels?: string;
    state: 'open';
    per_page: number;
  }): Promise<{ data: GitHubIssue[] }>;
}

export interface ProductOwnerGitHubSource {
  owner: string;
  repo: string;
  issues: GitHubIssuesApi;
}

export interface ProductOwnerSnapshotSource {
  repoRoot: string;
  stateDir: string;
  loadProposals: () => Promise<Proposal[]>;
  loadIdeas: () => Promise<IdeaSubmission[]>;
  github?: ProductOwnerGitHubSource;
  staleIssueDays?: number;
}

export const PRODUCT_OWNER_SNAPSHOT_CONFIG: SnapshotConfig = {
  maxBacklogEntries: 50,
  maxProposalEntries: 20,
  maxIdeaEntries: 10,
  maxDefaultEntries: 50,
  maxFindingsEntries: 5,
};

export async function buildProductOwnerSignalSnapshot(
  source: ProductOwnerSnapshotSource,
  config: SnapshotConfig = PRODUCT_OWNER_SNAPSHOT_CONFIG,
): Promise<SignalSnapshot> {
  let proposalsPromise: Promise<Proposal[]> | undefined;
  let ideasPromise: Promise<IdeaSubmission[]> | undefined;

  const loadProposals = () => {
    proposalsPromise ??= source.loadProposals();
    return proposalsPromise;
  };
  const loadIdeas = () => {
    ideasPromise ??= source.loadIdeas();
    return ideasPromise;
  };

  return assembleSignalSnapshot(
    {
      getSpecPipeline: async () => readSpecPipeline(source.repoRoot),
      getDeliverySummary: async () => readDeliverySummary(source.stateDir),
      getBacklog: async () => readBacklog(source.github, source.staleIssueDays ?? 30),
      getActiveProposals: async () => summarizeActiveProposals(await loadProposals()),
      getProposalHistory: async () => summarizeProposalHistory(await loadProposals()),
      getIdeaInbox: async () => summarizeIdeaInbox(await loadIdeas()),
      getFindingsAwaitingApproval: async () => readFindingsAwaitingApproval(source.github),
    },
    config,
  );
}

export async function buildProductOwnerSessionVariables(
  source: ProductOwnerSnapshotSource,
  config: SnapshotConfig = PRODUCT_OWNER_SNAPSHOT_CONFIG,
): Promise<Record<string, string>> {
  const snapshot = await buildProductOwnerSignalSnapshot(source, config);
  return { signal_snapshot: JSON.stringify(snapshot, null, 2) };
}

async function readSpecPipeline(repoRoot: string): Promise<SignalSnapshot['specPipeline']> {
  const traceability = await readFile(join(repoRoot, '.specify', 'traceability.yml'), 'utf-8');
  return computeSpecGaps(traceability);
}

async function readDeliverySummary(stateDir: string): Promise<SignalSnapshot['deliverySummary']> {
  const runs = await readRunStates(stateDir);
  const byRepo = new Map<string, { completed: number; terminal: number }>();

  for (const run of runs) {
    const repo = run.repoOwner && run.repoName ? `${run.repoOwner}/${run.repoName}` : 'unknown';
    const entry = byRepo.get(repo) ?? { completed: 0, terminal: 0 };
    if (run.phase === 'stuck') {
      entry.terminal++;
    } else if (run.phaseCompletions[run.phase] === true && isComplete(run.phase, 'success')) {
      entry.completed++;
      entry.terminal++;
    }
    byRepo.set(repo, entry);
  }

  return [...byRepo.entries()]
    .filter(([, entry]) => entry.terminal > 0)
    .map(([repo, entry]) => ({
      repo,
      passRate: entry.completed / entry.terminal,
      completionCount: entry.completed,
    }));
}

async function readRunStates(stateDir: string): Promise<RunState[]> {
  const runsDir = join(stateDir, 'runs');
  let files: string[];
  try {
    files = await readdir(runsDir);
  } catch (e) {
    if (isMissingPathError(e)) return [];
    console.warn('[po-snapshot] failed to read run states:', e);
    return [];
  }
  const runs: RunState[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const result = await readJsonSafe<RunState>(join(runsDir, file));
    if (result.ok) runs.push(result.value);
  }
  return runs;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function readBacklog(
  github: ProductOwnerGitHubSource | undefined,
  staleIssueDays: number,
): Promise<SignalSnapshot['backlog']> {
  if (!github) return [];
  const { data } = await github.issues.listForRepo({
    owner: github.owner,
    repo: github.repo,
    state: 'open',
    per_page: 100,
  });
  return data
    .filter((issue) => !issue.pull_request)
    .map((issue) => {
      const ageDays = daysSince(issue.created_at);
      return {
        issueNumber: issue.number,
        title: issue.title,
        labels: getLabelNames(issue.labels),
        ageDays,
        isStale: ageDays >= staleIssueDays,
      };
    });
}

async function readFindingsAwaitingApproval(
  github: ProductOwnerGitHubSource | undefined,
): Promise<FindingAwaitingApproval[]> {
  if (!github) return [];
  const { data } = await github.issues.listForRepo({
    owner: github.owner,
    repo: github.repo,
    labels: 'review-finding,tl-approved',
    state: 'open',
    per_page: 100,
  });

  return data
    .filter((issue) => !issue.pull_request)
    .filter((issue) => {
      const labels = getLabelNames(issue.labels);
      return !labels.includes('po-approved') && !labels.includes('po-rejected');
    })
    .map((issue) => {
      const labels = getLabelNames(issue.labels);
      return {
        issueNumber: issue.number,
        title: issue.title,
        severityLabel: labels.find((label) => /^P[0-3]$/.test(label)),
        tlApprovalReason: firstNonEmptyLine(issue.body ?? '') ?? 'tl-approved label present',
      };
    });
}

function summarizeActiveProposals(proposals: Proposal[]): SignalSnapshot['activeProposals'] {
  return proposals
    .filter((proposal) => proposal.status === 'proposed')
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      proposalType: inferProposalType(proposal),
    }));
}

function summarizeProposalHistory(proposals: Proposal[]): SignalSnapshot['proposalHistory'] {
  return proposals
    .filter((proposal) => proposal.status !== 'proposed')
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      proposalType: inferProposalType(proposal),
      outcome: proposal.status,
      operatorReason: proposal.decisionNotes,
    }));
}

function summarizeIdeaInbox(ideas: IdeaSubmission[]): SignalSnapshot['ideaInbox'] {
  return ideas
    .filter((idea) => idea.status === 'pending')
    .map((idea) => ({
      id: idea.id,
      content: idea.description,
      submittedAt: idea.createdAt,
    }));
}

function inferProposalType(proposal: Proposal): string {
  if (proposal.relatedSpecs.length > 0) return 'spec_advancement';
  if (proposal.relatedIssues.length > 0 || proposal.issueNumber !== null) return 'backlog_prioritization';
  return 'operator_idea_refinement';
}

function getLabelNames(labels: GitHubLabel[]): string[] {
  return labels
    .map((label) => typeof label === 'string' ? label : label.name ?? '')
    .filter((label) => label.length > 0);
}

function daysSince(timestamp: string): number {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 500);
}
