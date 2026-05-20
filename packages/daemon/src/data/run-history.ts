import type { SupabaseClient } from '@supabase/supabase-js';
import type { RunStore } from '@auto-claude/db';

export interface RunHistoryReader {
  countStuckRunsForIssue(input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  }): Promise<number | null>;
}

export interface RunMaintenance {
  markInProgressRunsStuck(): Promise<number | null>;
}

export class SupabaseRunHistory implements RunHistoryReader, RunMaintenance {
  constructor(private readonly supabase: SupabaseClient) {}

  async countStuckRunsForIssue(input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  }): Promise<number | null> {
    const { count, error } = await this.supabase
      .from('runs')
      .select('*', { count: 'exact', head: true })
      .eq('issue_number', input.issueNumber)
      .eq('repo_owner', input.repoOwner)
      .eq('repo_name', input.repoName)
      .eq('outcome', 'stuck');
    if (error) {
      console.warn(
        `[run-history] failed to count stuck runs for ${input.repoOwner}/${input.repoName}#${input.issueNumber}: ${error.message}`,
      );
      return null;
    }
    return count ?? 0;
  }

  async markInProgressRunsStuck(): Promise<number | null> {
    const { data, error } = await this.supabase
      .from('runs')
      .update({
        outcome: 'stuck',
        completed_at: new Date().toISOString(),
      } as never)
      .eq('outcome', 'in-progress')
      .select('id');
    if (error) {
      console.warn('[daemon] Failed to clean orphaned runs:', error.message);
      return null;
    }
    return data?.length ?? 0;
  }
}

export class PostgresRunHistory implements RunHistoryReader, RunMaintenance {
  constructor(private readonly runs: RunStore) {}

  async countStuckRunsForIssue(input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  }): Promise<number | null> {
    const result = await this.runs.countStuckRunsForIssue(input);
    if (!result.ok) {
      console.warn(
        `[run-history] failed to count stuck runs for ${input.repoOwner}/${input.repoName}#${input.issueNumber}: ${result.message}`,
      );
      return null;
    }
    return result.value;
  }

  async markInProgressRunsStuck(): Promise<number | null> {
    const result = await this.runs.markInProgressRunsStuck(new Date());
    if (!result.ok) {
      console.warn('[daemon] Failed to clean orphaned runs:', result.message);
      return null;
    }
    return result.value.length;
  }
}
