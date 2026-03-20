// packages/dashboard/lib/classify-issues.ts

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
}

export interface RunRecord {
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  outcome: 'in-progress' | 'complete' | 'stuck' | 'escalated';
  current_phase: string | null;
}

export type BoardColumn = 'not-ready' | 'ready' | 'running' | 'complete' | 'stuck';

export interface BoardCard {
  column: BoardColumn;
  issueNumber: number;
  issueTitle: string;
  repoOwner: string;
  repoName: string;
  issueUrl: string;
  labels: string[];
  currentPhase: string | null;
}

export function classifyIssues(
  repos: Array<{ owner: string; name: string; issues: GitHubIssue[] }>,
  runs: RunRecord[],
): BoardCard[] {
  const cards: BoardCard[] = [];

  // Index runs by "owner/name#number" for O(1) lookup
  const runIndex = new Map<string, RunRecord>();
  for (const run of runs) {
    runIndex.set(`${run.repo_owner}/${run.repo_name}#${run.issue_number}`, run);
  }

  // Classify open GitHub issues
  for (const repo of repos) {
    for (const issue of repo.issues) {
      const key = `${repo.owner}/${repo.name}#${issue.number}`;
      const run = runIndex.get(key);
      const labelNames = issue.labels.map((l) => l.name);

      let column: BoardColumn;
      let currentPhase: string | null = null;

      if (run?.outcome === 'in-progress' || labelNames.includes('in-progress')) {
        column = 'running';
        currentPhase = run?.current_phase ?? null;
      } else if (run?.outcome === 'stuck' || labelNames.includes('stuck')) {
        column = 'stuck';
      } else if (labelNames.includes('ready')) {
        column = 'ready';
      } else {
        column = 'not-ready';
      }

      cards.push({
        column,
        issueNumber: issue.number,
        issueTitle: issue.title,
        repoOwner: repo.owner,
        repoName: repo.name,
        issueUrl: issue.html_url,
        labels: labelNames,
        currentPhase,
      });
    }
  }

  // Add complete cards from DB runs (issues are closed on GitHub)
  for (const run of runs) {
    if (run.outcome !== 'complete') continue;
    const alreadyAdded = cards.some(
      (c) => c.repoOwner === run.repo_owner && c.repoName === run.repo_name && c.issueNumber === run.issue_number,
    );
    if (!alreadyAdded) {
      cards.push({
        column: 'complete',
        issueNumber: run.issue_number,
        issueTitle: run.issue_title,
        repoOwner: run.repo_owner,
        repoName: run.repo_name,
        issueUrl: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}`,
        labels: [],
        currentPhase: null,
      });
    }
  }

  return cards;
}
