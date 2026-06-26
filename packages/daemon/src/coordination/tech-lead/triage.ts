// packages/daemon/src/coordination/tech-lead/triage.ts
//
// Fetch untriaged finding issues and prepare the digest injection batch.

import type { Octokit } from '@octokit/rest';
import { type UntriagedIssue } from './schemas.js';

export interface FetchUntriagedIssuesDeps {
  octokit: Octokit;
  owner: string;
  repo: string;
}

function getLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
}

function extractSeverity(labels: string[]): string | undefined {
  return labels.find((l) => /^P\d$/.test(l));
}

const PER_PAGE = 100;

export async function fetchUntriagedIssues(
  deps: FetchUntriagedIssuesDeps,
  cap: number,
): Promise<UntriagedIssue[]> {
  if (cap <= 0) return [];

  const collected: UntriagedIssue[] = [];

  try {
    // Paginate: a single page (≤100) can be entirely `tl-triaged`, hiding
    // untriaged findings on later pages. Walk pages, applying the client-side
    // `tl-triaged` filter, until we have `cap` untriaged issues or pages run out.
    for (let page = 1; ; page++) {
      const { data } = await deps.octokit.issues.listForRepo({
        owner: deps.owner,
        repo: deps.repo,
        labels: 'review-finding',
        state: 'open',
        per_page: PER_PAGE,
        page,
      });

      const untriaged = data
        .filter((issue) => !('pull_request' in issue && issue.pull_request))
        .map((issue) => {
          const labels = getLabelNames(issue.labels);
          return {
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body ?? null,
            labels,
            severity: extractSeverity(labels),
          };
        })
        .filter((issue) => !issue.labels.includes('tl-triaged'));

      collected.push(...untriaged);

      // Stop once the cap is satisfied or the last page was short (exhausted).
      if (collected.length >= cap || data.length < PER_PAGE) break;
    }

    return collected.slice(0, cap);
  } catch (e) {
    console.warn(
      `[triage] failed to fetch untriaged issues: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}
