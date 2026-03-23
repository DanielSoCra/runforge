import { Octokit } from '@octokit/rest';
import type { WorkRequest } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

export interface WorkDetector {
  detectReadyWork(): Promise<Result<WorkRequest[]>>;
  detectBugFixWork(): Promise<Result<WorkRequest | null>>;
  claimWork(issueNumber: number): Promise<Result<void>>;
  claimBugFixWork(issueNumber: number): Promise<Result<void>>;
  completeWork(issueNumber: number, comment: string): Promise<Result<void>>;
  completeBugFixWork(issueNumber: number, commitSha: string): Promise<Result<void>>;
  markStuck(issueNumber: number, comment: string): Promise<Result<void>>;
}

export function createWorkDetector(octokit: Octokit, owner: string, repo: string): WorkDetector {
  return {
    async detectReadyWork(): Promise<Result<WorkRequest[]>> {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner, repo, labels: 'ready', state: 'open', per_page: 100,
        });
        const requests: WorkRequest[] = data
          .filter((issue) => !('pull_request' in issue && issue.pull_request))
          .map((issue) => ({
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body ?? '',
            labels: issue.labels.map((l) => typeof l === 'string' ? l : l.name ?? ''),
            specRefs: extractSpecRefs(issue.body ?? ''),
            scopeDescription: extractScopeDescription(issue.body ?? ''),
          }));
        return ok(requests);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async detectBugFixWork(): Promise<Result<WorkRequest | null>> {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner, repo, labels: 'review-finding', state: 'open', per_page: 100,
        });
        const candidates = data
          .filter((issue) => !('pull_request' in issue && issue.pull_request))
          .filter((issue) => {
            const labelNames = issue.labels.map((l) => typeof l === 'string' ? l : l.name ?? '');
            return !labelNames.includes('in-progress') && !labelNames.includes('blocked');
          });

        // Severity-gated priority: P0 > P1 > P2 (with auto-fix-approved only), never P3
        const picked = pickHighestPriority(candidates);
        if (!picked) return ok(null);

        const labels = picked.labels.map((l: any) => typeof l === 'string' ? l : l.name ?? '');
        return ok({
          issueNumber: picked.number,
          title: picked.title,
          body: picked.body ?? '',
          labels,
          specRefs: extractSpecRefs(picked.body ?? ''),
          scopeDescription: extractScopeDescription(picked.body ?? ''),
          workType: 'bug-fix' as const,
        });
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async claimBugFixWork(issueNumber: number): Promise<Result<void>> {
      try {
        // Add in-progress but preserve review-finding label
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['in-progress'] });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async completeBugFixWork(issueNumber: number, commitSha: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: `Fixed in commit ${commitSha}` });
        await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async claimWork(issueNumber: number): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'ready' }).catch(() => {});
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['in-progress'] });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async completeWork(issueNumber: number, comment: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['complete'] });
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
        await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },

    async markStuck(issueNumber: number, comment: string): Promise<Result<void>> {
      try {
        await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: 'in-progress' }).catch(() => {});
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['stuck'] });
        await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment });
        return ok(undefined);
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

/**
 * Picks the highest-priority review-finding issue by severity label.
 * P0 > P1 > P2 (only with auto-fix-approved). P3 is never returned.
 */
function pickHighestPriority(issues: any[]): any | null {
  const priorities: Array<{ priority: string; requiresApproval: boolean }> = [
    { priority: 'P0', requiresApproval: false },
    { priority: 'P1', requiresApproval: false },
    { priority: 'P2', requiresApproval: true },
  ];

  for (const { priority, requiresApproval } of priorities) {
    for (const issue of issues) {
      const labelNames = issue.labels.map((l: any) => typeof l === 'string' ? l : l.name ?? '');
      if (!labelNames.includes(priority)) continue;
      if (requiresApproval && !labelNames.includes('auto-fix-approved')) continue;
      return issue;
    }
  }

  return null;
}

function extractSpecRefs(body: string): string[] {
  // Match spec IDs like FUNC-AC-PIPELINE, ARCH-AC-CONTROL-PLANE, STACK-AC-CONVENTIONS
  const matches = body.match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g);
  return [...new Set(matches ?? [])];
}

/**
 * Extracts a scope description from the issue body.
 * Looks for an explicit "## Scope" section first, then falls back to the first
 * non-empty paragraph. Returns undefined if the body is empty or whitespace-only.
 */
function extractScopeDescription(body: string): string | undefined {
  if (!body.trim()) return undefined;

  // Look for an explicit scope section (## Scope, ### Scope, etc.)
  // Try to stop at the next heading; if none, capture everything after the Scope header.
  const scopeMatch = body.match(/^#{1,4}\s+Scope\s*\n([\s\S]*?)(?=\n#{1,4}\s)/im)
    ?? body.match(/^#{1,4}\s+Scope\s*\n([\s\S]*)/im);
  if (scopeMatch?.[1]?.trim()) {
    return scopeMatch[1].trim().slice(0, 500);
  }

  // Fall back to first non-empty paragraph (split on double newline)
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  const first = paragraphs[0]?.trim();
  if (first) {
    return first.slice(0, 500);
  }

  return undefined;
}
