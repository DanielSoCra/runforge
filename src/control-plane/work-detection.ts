import { Octokit } from '@octokit/rest';
import type { WorkRequest } from '../types.js';
import { ok, err, type Result } from '../lib/result.js';

export interface WorkDetector {
  detectReadyWork(): Promise<Result<WorkRequest[]>>;
  claimWork(issueNumber: number): Promise<Result<void>>;
  completeWork(issueNumber: number, comment: string): Promise<Result<void>>;
  markStuck(issueNumber: number, comment: string): Promise<Result<void>>;
}

export function createWorkDetector(octokit: Octokit, owner: string, repo: string): WorkDetector {
  return {
    async detectReadyWork(): Promise<Result<WorkRequest[]>> {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner, repo, labels: 'ready', state: 'open', per_page: 100,
        });
        const requests: WorkRequest[] = data.map((issue) => ({
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          labels: issue.labels.map((l) => typeof l === 'string' ? l : l.name ?? ''),
          specRefs: extractSpecRefs(issue.body ?? ''),
        }));
        return ok(requests);
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

function extractSpecRefs(body: string): string[] {
  // Match spec IDs like FUNC-AC-PIPELINE, ARCH-AC-CONTROL-PLANE, STACK-AC-CONVENTIONS
  const matches = body.match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g);
  return [...new Set(matches ?? [])];
}
