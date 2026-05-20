'use server';

import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';
import { formatDuration } from '@/lib/format';
import { getDashboardStores } from '@/lib/data/stores';
import type { Database } from '@/lib/types';

type Briefing = Database['public']['Tables']['briefings']['Row'];
type ActivityEvent = Database['public']['Tables']['activity_events']['Row'];

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

/**
 * Compute a human-readable duration from a timestamp to now.
 * Examples: "<1m", "30m", "2h", "3d"
 */
// formatDuration moved to lib/format.ts (Next.js 16 requires all 'use server' exports to be async)

const URGENCY_ORDER: Record<AttentionItem['reason'], number> = {
  blocked: 0,
  review: 1,
  failure: 2,
};

/**
 * Fetch the most recent briefing snapshot.
 */
export async function getLatestBriefing(): Promise<Briefing | null> {
  const supabase = await createClient();
  await requireUser(supabase);
  const { data, error } = await supabase
    .from('briefings')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows found
      return null;
    }
    console.error('[briefing] getLatestBriefing failed:', error);
    throw new Error('Failed to fetch latest briefing');
  }
  return data ?? null;
}

/**
 * Fetch all runs currently in progress.
 */
export async function getActiveRuns() {
  const supabase = await createClient();
  await requireUser(supabase);
  const { data, error } = await supabase
    .from('runs')
    .select('id, repo_owner, repo_name, issue_number, issue_title, current_phase, outcome, total_cost, started_at, phases')
    .eq('outcome', 'in-progress')
    .order('started_at', { ascending: true });

  if (error) {
    console.error('[briefing] getActiveRuns failed:', error);
    throw new Error('Failed to fetch active runs');
  }
  // Deduplicate by issue — keep latest run per issue (multiple runs can exist from retries)
  const seen = new Map<string, typeof data[number]>();
  for (const run of data ?? []) {
    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    const existing = seen.get(key);
    if (!existing || run.started_at > existing.started_at) {
      seen.set(key, run);
    }
  }
  return [...seen.values()];
}

/**
 * Aggregate items that need human attention from stuck and escalated runs.
 * Sorted by urgency: blocked (0) > review (1) > failure (2).
 */
export async function getNeedsAttention(): Promise<AttentionItem[]> {
  const supabase = await createClient();
  await requireUser(supabase);

  const [stuckResult, escalatedResult, failedResult] = await Promise.all([
    supabase
      .from('runs')
      .select('id, repo_owner, repo_name, issue_number, issue_title, outcome, started_at')
      .eq('outcome', 'stuck'),
    supabase
      .from('runs')
      .select('id, repo_owner, repo_name, issue_number, issue_title, outcome, started_at')
      .eq('outcome', 'escalated'),
    supabase
      .from('runs')
      .select('id, repo_owner, repo_name, issue_number, issue_title, outcome, started_at')
      .eq('outcome', 'failed'),
  ]);

  if (stuckResult.error) {
    console.error('[briefing] getNeedsAttention stuck query failed:', stuckResult.error);
    throw new Error('Failed to fetch stuck runs');
  }
  if (escalatedResult.error) {
    console.error('[briefing] getNeedsAttention escalated query failed:', escalatedResult.error);
    throw new Error('Failed to fetch escalated runs');
  }
  if (failedResult.error) {
    console.error('[briefing] getNeedsAttention failed query failed:', failedResult.error);
    throw new Error('Failed to fetch failed runs');
  }

  // Deduplicate by issue — keep most urgent entry per issue, with latest timestamp
  const byIssue = new Map<string, AttentionItem>();

  const addRun = (run: { issue_number: number; repo_owner: string; repo_name: string; started_at: string }, reason: AttentionItem['reason']) => {
    const key = `${run.repo_owner}/${run.repo_name}#${run.issue_number}`;
    const existing = byIssue.get(key);
    // Keep the more urgent reason, or the newer run if same urgency
    if (!existing || URGENCY_ORDER[reason] < URGENCY_ORDER[existing.reason]) {
      byIssue.set(key, {
        issueNumber: run.issue_number,
        repoOwner: run.repo_owner,
        repoName: run.repo_name,
        reason,
        waitDuration: formatDuration(run.started_at),
        actionLinks: [
          { label: 'View Issue', url: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}` },
        ],
      });
    }
  };

  for (const run of stuckResult.data ?? []) addRun(run, 'blocked');
  for (const run of escalatedResult.data ?? []) addRun(run, 'review');
  for (const run of failedResult.data ?? []) addRun(run, 'failure');

  const items = [...byIssue.values()];
  items.sort((a, b) => URGENCY_ORDER[a.reason] - URGENCY_ORDER[b.reason]);

  return items;
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
  labels: GitHubIssueLabel[];
  pull_request?: unknown;
}

/**
 * Fetch queued work items that are up next.
 *
 * Queries GitHub Issues with pipeline-stage labels from enabled repos,
 * excludes issues with in-progress runs, and sorts by label priority.
 */
export async function getUpNext(): Promise<UpNextItem[]> {
  const supabase = await createClient();
  await requireUser(supabase);
  let stores: ReturnType<typeof getDashboardStores> | undefined;
  const getStores = () => stores ??= getDashboardStores();

  // Fetch enabled repos and active runs in parallel
  const [reposResult, runsResult] = await Promise.all([
    supabase
      .from('repos')
      .select('id, owner, name, connection_id')
      .eq('enabled', true)
      .is('deleted_at', null),
    supabase
      .from('runs')
      .select('issue_number, repo_owner, repo_name')
      .eq('outcome', 'in-progress'),
  ]);

  if (reposResult.error) {
    console.error('[briefing] getUpNext repos query failed:', reposResult.error);
    throw new Error('Failed to fetch repos for up-next');
  }
  if (runsResult.error) {
    console.error('[briefing] getUpNext runs query failed:', runsResult.error);
    throw new Error('Failed to fetch runs for up-next');
  }

  const repos = (reposResult.data ?? []) as Array<{
    id: string; owner: string; name: string; connection_id: string | null;
  }>;
  if (repos.length === 0) return [];

  const connectionIds = [...new Set(
    repos
      .map((repo) => repo.connection_id)
      .filter((connectionId): connectionId is string => Boolean(connectionId)),
  )];
  const tokensByConnectionId = new Map<string, string | undefined>();
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const credential = await getStores().githubConnections.readCredential(connectionId);
      tokensByConnectionId.set(
        connectionId,
        credential.ok ? credential.value.token : process.env.GITHUB_TOKEN,
      );
    }),
  );

  // Build set of in-progress run keys for exclusion
  const activeRunKeys = new Set(
    (runsResult.data ?? []).map(
      (r: { repo_owner: string; repo_name: string; issue_number: number }) =>
        `${r.repo_owner}/${r.repo_name}#${r.issue_number}`,
    ),
  );

  // Resolve tokens and fetch issues per repo (first 100 per repo — sufficient for pipeline queues)
  const perRepoItems = await Promise.all(
    repos.map(async (repo): Promise<UpNextItem[]> => {
      const token = repo.connection_id
        ? tokensByConnectionId.get(repo.connection_id)
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

/**
 * Refresh live panel data (called by auto-refresh interval on the client).
 */
export async function refreshLivePanels() {
  const supabase = await createClient();
  await requireUser(supabase);
  const [activeRuns, needsAttention, upNext] = await Promise.all([
    getActiveRuns(),
    getNeedsAttention(),
    getUpNext(),
  ]);
  return { activeRuns, needsAttention, upNext };
}

/**
 * Fetch recent activity events with cursor-based pagination.
 * Defaults to 50 events per page.
 */
export async function getActivityFeed(
  opts?: { cursor?: string; pageSize?: number },
): Promise<ActivityEvent[]> {
  const supabase = await createClient();
  await requireUser(supabase);
  const pageSize = opts?.pageSize ?? 50;

  let query = supabase
    .from('activity_events')
    .select('*')
    .order('occurred_at', { ascending: false });

  if (opts?.cursor) {
    query = query.lt('occurred_at', opts.cursor);
  }

  const { data, error } = await query.limit(pageSize);

  if (error) {
    console.error('[briefing] getActivityFeed failed:', error);
    throw new Error('Failed to fetch activity feed');
  }
  return data ?? [];
}
