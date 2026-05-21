'use server';

import { requireDashboardUser } from '@/lib/auth/require-session';
import { formatDuration } from '@/lib/format';
import {
  getDashboardStores,
  type DashboardActivityEvent,
  type DashboardBriefing,
  type DashboardBriefingRun,
} from '@/lib/data/stores';

export type AttentionItem = {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  reason: 'blocked' | 'review' | 'failure';
  waitDuration: string;
  actionLinks: { label: string; url: string }[];
};

export type UpNextItem = {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  pipelineLabel: string;
};

const URGENCY_ORDER: Record<AttentionItem['reason'], number> = {
  blocked: 0,
  review: 1,
  failure: 2,
};

/**
 * Fetch the most recent briefing snapshot.
 */
export async function getLatestBriefing(): Promise<DashboardBriefing | null> {
  await requireDashboardUser();
  return readLatestBriefing();
}

/**
 * Fetch all runs currently in progress.
 */
export async function getActiveRuns() {
  await requireDashboardUser();
  return readActiveRuns();
}

/**
 * Aggregate items that need human attention from stuck and escalated runs.
 * Sorted by urgency: blocked (0) > review (1) > failure (2).
 */
export async function getNeedsAttention(): Promise<AttentionItem[]> {
  await requireDashboardUser();
  return readNeedsAttention();
}

// Pipeline labels that indicate queued work, ordered by priority (highest first).
// Issues with "implementing" or "in-progress" labels are excluded — they're active, not queued.
const PIPELINE_STAGE_LABELS = [
  'ready-to-implement',
  'l3-approved',
  'l2-approved',
  'l1-approved',
] as const;

const ACTIVE_LABELS = new Set(['implementing', 'in-progress']);

const STAGE_PRIORITY: Record<string, number> = Object.fromEntries(
  PIPELINE_STAGE_LABELS.map((label, i) => [label, i]),
);

interface GitHubIssueLabel {
  name: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<GitHubIssueLabel | string>;
  pull_request?: unknown;
}

/**
 * Fetch queued work items that are up next.
 *
 * Queries GitHub Issues with pipeline-stage labels from enabled repos,
 * excludes issues with in-progress runs, and sorts by label priority.
 */
export async function getUpNext(): Promise<UpNextItem[]> {
  await requireDashboardUser();
  return readUpNext();
}

/**
 * Refresh live panel data (called by auto-refresh interval on the client).
 */
export async function refreshLivePanels() {
  await requireDashboardUser();
  const [activeRuns, needsAttention, upNext] = await Promise.all([
    readActiveRuns(),
    readNeedsAttention(),
    readUpNext(),
  ]);
  return { activeRuns, needsAttention, upNext };
}

/**
 * Fetch recent activity events with cursor-based pagination.
 * Defaults to 50 events per page.
 */
export async function getActivityFeed(
  opts?: { cursor?: string; pageSize?: number },
): Promise<DashboardActivityEvent[]> {
  await requireDashboardUser();
  return readActivityFeed(opts);
}

async function readLatestBriefing(): Promise<DashboardBriefing | null> {
  const result = await getDashboardStores().briefings.readLatestBriefing();
  if (result.ok) return result.value;
  if (result.error === 'not-found') return null;

  console.error('[briefing] getLatestBriefing failed:', result);
  throw new Error('Failed to fetch latest briefing');
}

async function readActiveRuns(): Promise<DashboardBriefingRun[]> {
  const result = await getDashboardStores().briefings.listActiveRuns();
  if (!result.ok) {
    console.error('[briefing] getActiveRuns failed:', result);
    throw new Error('Failed to fetch active runs');
  }

  return latestRunByIssue(result.value);
}

async function readNeedsAttention(): Promise<AttentionItem[]> {
  const result = await getDashboardStores().briefings.listAttentionRuns();
  if (!result.ok) {
    console.error('[briefing] getNeedsAttention failed:', result);
    throw new Error('Failed to fetch attention runs');
  }

  const byIssue = new Map<
    string,
    { item: AttentionItem; startedAt: string }
  >();

  for (const run of result.value) {
    const reason = attentionReasonForOutcome(run.outcome);
    if (!reason) continue;

    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    const existing = byIssue.get(key);
    if (
      existing &&
      (URGENCY_ORDER[existing.item.reason] < URGENCY_ORDER[reason] ||
        (URGENCY_ORDER[existing.item.reason] === URGENCY_ORDER[reason] &&
          existing.startedAt >= run.started_at))
    ) {
      continue;
    }

    byIssue.set(key, {
      startedAt: run.started_at,
      item: {
        issueNumber: run.issue_number,
        repoOwner: run.repo_owner,
        repoName: run.repo_name,
        reason,
        waitDuration: formatDuration(run.started_at),
        actionLinks: [
          {
            label: 'View Issue',
            url: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}`,
          },
        ],
      },
    });
  }

  const items = [...byIssue.values()].map(({ item }) => item);
  items.sort((a, b) => URGENCY_ORDER[a.reason] - URGENCY_ORDER[b.reason]);

  return items;
}

async function readUpNext(): Promise<UpNextItem[]> {
  const stores = getDashboardStores();
  const boardInputs = await stores.issues.listBoardInputs();

  if (!boardInputs.ok) {
    console.error('[briefing] getUpNext board input query failed:', boardInputs);
    throw new Error('Failed to fetch repos for up-next');
  }

  const { repos, runs } = boardInputs.value;
  if (repos.length === 0) return [];

  const connectionIds = [...new Set(
    repos
      .map((repo) => repo.connectionId)
      .filter((connectionId): connectionId is string => Boolean(connectionId)),
  )];
  const tokensByConnectionId = new Map<string, string | undefined>();
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const credential = await stores.githubConnections.readCredential(
        connectionId,
      );
      tokensByConnectionId.set(
        connectionId,
        credential.ok ? credential.value.token : process.env.GITHUB_TOKEN,
      );
    }),
  );

  // Build set of in-progress run keys for exclusion
  const activeRunKeys = new Set(
    runs
      .filter((run) => run.outcome === 'in-progress')
      .map((run) => `${run.repo_owner}/${run.repo_name}#${run.issue_number}`),
  );

  // Resolve tokens and fetch issues per repo (first 100 per repo — sufficient for pipeline queues)
  const perRepoItems = await Promise.all(
    repos.map(async (repo): Promise<UpNextItem[]> => {
      const token = repo.connectionId
        ? tokensByConnectionId.get(repo.connectionId)
        : process.env.GITHUB_TOKEN;
      if (!token) return [];

      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/issues?state=open&labels=feature-pipeline&per_page=100`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
            },
          },
        );
        if (!res.ok) return [];

        const issues = (await res.json()) as GitHubIssue[];
        const repoItems: UpNextItem[] = [];

        for (const issue of issues) {
          // Skip PRs (GitHub issues endpoint includes them)
          if ('pull_request' in issue && issue.pull_request) continue;

          const labelNames = (issue.labels ?? []).map((l) => typeof l === 'string' ? l : l.name);

          // Skip actively being worked on
          if (labelNames.some((l) => ACTIVE_LABELS.has(l))) continue;

          // Skip issues with in-progress runs
          const key = `${repo.owner}/${repo.name}#${issue.number}`;
          if (activeRunKeys.has(key)) continue;

          // Find the highest-priority pipeline stage label
          const stageLabel = PIPELINE_STAGE_LABELS.find((sl) =>
            labelNames.includes(sl),
          );
          if (!stageLabel) continue;

          repoItems.push({
            issueNumber: issue.number,
            repoOwner: repo.owner,
            repoName: repo.name,
            pipelineLabel: stageLabel,
          });
        }
        return repoItems;
      } catch {
        // Skip repo on fetch failure — degrade gracefully
        return [];
      }
    }),
  );

  const items = perRepoItems.flat();

  // Sort by pipeline stage priority (ready-to-implement first)
  items.sort(
    (a, b) => (STAGE_PRIORITY[a.pipelineLabel] ?? 99) - (STAGE_PRIORITY[b.pipelineLabel] ?? 99),
  );

  return items;
}

async function readActivityFeed(
  opts?: { cursor?: string; pageSize?: number },
): Promise<DashboardActivityEvent[]> {
  const result = await getDashboardStores().briefings.listActivityEvents({
    cursor: opts?.cursor,
    pageSize: opts?.pageSize ?? 50,
  });
  if (!result.ok) {
    console.error('[briefing] getActivityFeed failed:', result);
    throw new Error('Failed to fetch activity feed');
  }

  return result.value;
}

function latestRunByIssue(runs: DashboardBriefingRun[]) {
  const seen = new Map<string, DashboardBriefingRun>();
  for (const run of runs) {
    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    const existing = seen.get(key);
    if (!existing || run.started_at > existing.started_at) {
      seen.set(key, run);
    }
  }
  return [...seen.values()];
}

function attentionReasonForOutcome(
  outcome: DashboardBriefingRun['outcome'],
): AttentionItem['reason'] | null {
  switch (outcome) {
    case 'stuck':
      return 'blocked';
    case 'escalated':
      return 'review';
    case 'failed':
      return 'failure';
    default:
      return null;
  }
}
