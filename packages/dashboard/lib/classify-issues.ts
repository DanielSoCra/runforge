// packages/dashboard/lib/classify-issues.ts

export interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
}

export interface RunRecord {
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  outcome: 'in-progress' | 'complete' | 'stuck' | 'escalated' | 'failed';
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
  // runs are newest-first (ORDER BY started_at DESC), so first-write-wins = newest run wins
  const runIndex = new Map<string, RunRecord>();
  for (const run of runs) {
    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    if (!runIndex.has(key)) {  // first-write-wins: runs are newest-first
      runIndex.set(key, run);
    }
  }

  // Track emitted keys from the first loop to prevent double-counting complete runs
  const emittedKeys = new Set<string>();

  // Build set of enabled repo keys so the complete-runs loop only includes enabled repos
  const enabledRepos = new Set(repos.map((r) => `${r.owner}/${r.name}`));

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
      } else if (
        run?.outcome === 'stuck' ||
        run?.outcome === 'escalated' ||
        run?.outcome === 'failed' ||
        labelNames.includes('stuck')
      ) {
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
      emittedKeys.add(key);
    }
  }

  // Add complete cards from DB runs (closed issues not in GitHub open-issue API response)
  // Only include runs from enabled repos to avoid showing cards for disabled repos
  for (const run of runs) {
    if (run.outcome !== 'complete') continue;
    const repoKey = `${run.repo_owner}/${run.repo_name}`;
    if (!enabledRepos.has(repoKey)) continue;
    const key = `${repoKey}#${run.issue_number}`;
    if (!emittedKeys.has(key)) {
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
      emittedKeys.add(key);
    }
  }

  return cards;
}
