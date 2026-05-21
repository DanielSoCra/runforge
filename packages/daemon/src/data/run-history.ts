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
