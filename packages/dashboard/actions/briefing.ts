'use server';

import { createClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/types';

type Briefing = Database['public']['Tables']['briefings']['Row'];
type Run = Database['public']['Tables']['runs']['Row'];
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
export function formatDuration(start: string): string {
  const ms = Date.now() - new Date(start).getTime();
  const minutes = Math.floor(ms / (1000 * 60));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

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
  const { data, error } = await supabase
    .from('briefings')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code === 'PGRST116') {
    // No rows found
    return null;
  }
  return data ?? null;
}

/**
 * Fetch all runs currently in progress.
 */
export async function getActiveRuns() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('runs')
    .select('id, repo_owner, repo_name, issue_number, issue_title, current_phase, outcome, total_cost, started_at, phases')
    .eq('outcome', 'in-progress')
    .order('started_at', { ascending: true });

  if (error) {
    console.error('[briefing] getActiveRuns failed:', error);
    throw new Error('Failed to fetch active runs');
  }
  return data ?? [];
}

/**
 * Aggregate items that need human attention from stuck and escalated runs.
 * Sorted by urgency: blocked (0) > review (1) > failure (2).
 */
export async function getNeedsAttention(): Promise<AttentionItem[]> {
  const supabase = await createClient();

  const [stuckResult, escalatedResult] = await Promise.all([
    supabase
      .from('runs')
      .select('id, repo_owner, repo_name, issue_number, issue_title, outcome, started_at')
      .eq('outcome', 'stuck'),
    supabase
      .from('runs')
      .select('id, repo_owner, repo_name, issue_number, issue_title, outcome, started_at')
      .eq('outcome', 'escalated'),
  ]);

  if (stuckResult.error) {
    console.error('[briefing] getNeedsAttention stuck query failed:', stuckResult.error);
    throw new Error('Failed to fetch stuck runs');
  }
  if (escalatedResult.error) {
    console.error('[briefing] getNeedsAttention escalated query failed:', escalatedResult.error);
    throw new Error('Failed to fetch escalated runs');
  }

  const items: AttentionItem[] = [];

  for (const run of stuckResult.data ?? []) {
    items.push({
      issueNumber: run.issue_number,
      repoOwner: run.repo_owner,
      repoName: run.repo_name,
      reason: 'blocked',
      waitDuration: formatDuration(run.started_at),
      actionLinks: [
        { label: 'View Issue', url: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}` },
      ],
    });
  }

  for (const run of escalatedResult.data ?? []) {
    items.push({
      issueNumber: run.issue_number,
      repoOwner: run.repo_owner,
      repoName: run.repo_name,
      reason: 'review',
      waitDuration: formatDuration(run.started_at),
      actionLinks: [
        { label: 'View Issue', url: `https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}` },
      ],
    });
  }

  items.sort((a, b) => URGENCY_ORDER[a.reason] - URGENCY_ORDER[b.reason]);

  return items;
}

/**
 * Fetch queued work items that are up next.
 *
 * TODO: This will query GitHub Issues with pipeline labels once the daemon
 * integration is complete. For now, returns an empty array since queued items
 * are tracked externally via GitHub issue labels, not as run rows.
 */
export async function getUpNext(): Promise<UpNextItem[]> {
  return [];
}

/**
 * Refresh live panel data (called by auto-refresh interval on the client).
 */
export async function refreshLivePanels() {
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
