// src/coordination/product-owner/finding-approval.ts — PO finding approval: cap tracking, fetching, and verdict application
import type { POFindingDailyCap, POFindingDecision, FindingAwaitingApproval } from './schemas.js';
import { POFindingDailyCapSchema } from './schemas.js';
import type { Result } from '../../lib/result.js';

// --- Verdict label mapping (applied via injected Octokit) ---

export const VERDICT_LABELS: Record<string, { add: string[]; remove: string[] }> = {
  approve: { add: ['po-approved'], remove: [] },
  reject: { add: ['po-rejected'], remove: ['tl-approved'] },
  needs_discussion: { add: ['needs-discussion'], remove: [] },
};

// --- Dependency injection for persistence ---

export interface FindingApprovalDeps {
  readJson: <T>(path: string) => Promise<Result<T>>;
  writeJson: <T>(path: string, data: T) => Promise<void>;
  capStatePath: string;
}

// --- Minimal Octokit interface for type safety without importing the full package ---

interface OctokitLike {
  issues: {
    listForRepo: (params: { owner: string; repo: string; labels: string; state: string }) => Promise<{ data: Array<{ number: number; title: string; labels: Array<{ name?: string } | string> }> }>;
    addLabels: (params: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<unknown>;
    removeLabel: (params: { owner: string; repo: string; issue_number: number; name: string }) => Promise<unknown>;
    createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
  };
}

// --- Daily cap state ---

export function getRemainingCapacity(state: POFindingDailyCap, cap: number): number {
  const today = new Date().toISOString().slice(0, 10);
  const used = state.date === today ? state.approvedCount : 0;
  return Math.max(0, cap - used);
}

export async function readCapState(deps: FindingApprovalDeps): Promise<POFindingDailyCap> {
  const result = await deps.readJson<POFindingDailyCap>(deps.capStatePath);
  if (result.ok) {
    const parsed = POFindingDailyCapSchema.safeParse(result.value);
    if (parsed.success) return parsed.data;
  }
  return { date: new Date().toISOString().slice(0, 10), approvedCount: 0 };
}

export async function incrementCapCounter(deps: FindingApprovalDeps): Promise<void> {
  const state = await readCapState(deps);
  const today = new Date().toISOString().slice(0, 10);
  const updated: POFindingDailyCap = state.date === today
    ? { date: today, approvedCount: state.approvedCount + 1 }
    : { date: today, approvedCount: 1 };
  await deps.writeJson(deps.capStatePath, updated);
}

// --- Fetch tl-approved findings from GitHub ---

function labelName(label: { name?: string } | string): string {
  return typeof label === 'string' ? label : (label.name ?? '');
}

const SKIP_LABELS = ['po-approved', 'po-rejected', 'needs-discussion', 'auto-fix-approved'];

export async function fetchFindingsAwaitingApproval(
  octokit: OctokitLike,
  owner: string,
  repo: string,
): Promise<FindingAwaitingApproval[]> {
  const response = await octokit.issues.listForRepo({
    owner,
    repo,
    labels: 'tl-approved',
    state: 'open',
  });

  return response.data
    .filter(issue => !issue.labels.some(l => SKIP_LABELS.includes(labelName(l))))
    .map(issue => {
      const labels = issue.labels.map(l => labelName(l));
      const severityLabel = labels.find(l => l.startsWith('severity-'));
      // TODO: Extract actual TL approval reason from issue comments via
      // octokit.issues.listComments. Current placeholder avoids extra API calls.
      return {
        issueNumber: issue.number,
        title: issue.title,
        severityLabel,
        tlApprovalReason: `TL approved finding #${issue.number}`,
      };
    });
}

// --- Apply finding decisions via Octokit ---

export async function applyFindingDecisions(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  decisions: POFindingDecision[],
  deps: FindingApprovalDeps,
): Promise<void> {
  for (const decision of decisions) {
    const mapping = VERDICT_LABELS[decision.verdict];
    if (!mapping) continue;

    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: decision.issueNumber,
      labels: mapping.add,
    });

    for (const label of mapping.remove) {
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: decision.issueNumber,
        name: label,
      }).catch(() => { /* 404 when label not present — safe to ignore */ });
    }

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: decision.issueNumber,
      body: `**PO ${decision.verdict}:** ${decision.reason}`,
    });

    // TODO(STACK-AC-PRODUCT-OWNER-INTERACTIVE): For needs_discussion verdicts,
    // add NeedsDiscussionItem to SharedPOState with sourceType: 'finding' and
    // sourceRef set to the issue URL. Use writeWithRetry for optimistic concurrency.

    if (decision.verdict === 'approve') {
      await incrementCapCounter(deps);
    }
  }
}
