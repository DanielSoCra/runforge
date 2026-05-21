import { execFile as nodeExecFile } from 'node:child_process';
import type { ConciergeEventStore } from '../memory/state-stores.js';
import { shouldIgnoreObservedPath } from './filters.js';

export interface RepoBranchHead {
  name: string;
  commit: string;
}

export interface RepoActivityClient {
  listBranches(repoPath: string): Promise<RepoBranchHead[]>;
}

export interface RepoActivityPoller {
  pollOnce(): Promise<boolean>;
}

export interface RepoActivityPollerOptions {
  watchedRepos: string[];
  client: RepoActivityClient;
  events: ConciergeEventStore;
}

export interface RepoActivityExecFileResult {
  stdout: string;
}

export type RepoActivityExecFile = (
  file: string,
  args: string[],
) => Promise<RepoActivityExecFileResult>;

export interface GitRepoActivityClientOptions {
  execFile?: RepoActivityExecFile;
}

export function createRepoActivityPoller(options: RepoActivityPollerOptions): RepoActivityPoller {
  const snapshots = new Map<string, Map<string, string>>();
  const watchedRepos = options.watchedRepos.filter((repoPath) => !shouldIgnoreObservedPath(repoPath));

  return {
    async pollOnce(): Promise<boolean> {
      let emitted = false;
      for (const repoPath of watchedRepos) {
        const current = await readBranchSnapshot(options.client, repoPath);
        const previous = snapshots.get(repoPath);
        snapshots.set(repoPath, current);
        if (!previous) continue;

        for (const [branch, commit] of current) {
          const previousCommit = previous.get(branch);
          if (!previousCommit) {
            options.events.append({
              source: 'observer',
              type: 'manual_branch_created',
              status: 'new',
              payload: { repoPath, branch, commit },
            });
            emitted = true;
          } else if (previousCommit !== commit) {
            options.events.append({
              source: 'observer',
              type: 'manual_commit',
              status: 'new',
              payload: {
                repoPath,
                branch,
                commit,
                previousCommit,
              },
            });
            emitted = true;
          }
        }
      }
      return emitted;
    },
  };
}

export function createGitRepoActivityClient(
  options: GitRepoActivityClientOptions = {},
): RepoActivityClient {
  const execFile = options.execFile ?? defaultExecFile;
  return {
    async listBranches(repoPath): Promise<RepoBranchHead[]> {
      const result = await execFile('git', [
        '-C',
        repoPath,
        'for-each-ref',
        '--format=%(refname:short)%00%(objectname)',
        'refs/heads',
      ]);
      return parseBranchHeads(result.stdout);
    },
  };
}

async function readBranchSnapshot(
  client: RepoActivityClient,
  repoPath: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const branch of await client.listBranches(repoPath)) {
    snapshot.set(branch.name, branch.commit);
  }
  return snapshot;
}

function parseBranchHeads(stdout: string): RepoBranchHead[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [name, commit] = line.split('\u0000');
      if (!name || !commit) return [];
      return [{ name, commit }];
    });
}

async function defaultExecFile(file: string, args: string[]): Promise<RepoActivityExecFileResult> {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile(file, args, { encoding: 'utf-8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise({ stdout: String(stdout) });
    });
  });
}
