// Non-gate regression coverage for the revert lane's real-remote edge cases.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  DecisionRequestSchema,
  type DecisionRequest,
} from '@auto-claude/decision-protocol';
import type { RunState } from '../types.js';
import {
  buildDegradedReversalEscalationRequest,
  handlePostLandingObservation,
} from './revert-lane.js';

const FIXED_NOW = '2026-07-03T12:00:00.000Z';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function sh(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Command "${cmd} ${args.join(' ')}" failed:\n${String(result.stderr ?? '')}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function gitRefExists(repoDir: string, ref: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', ref], {
    cwd: repoDir,
    stdio: 'pipe',
  });
  return result.status === 0;
}

function trackedFilesAt(repoDir: string, ref: string): string[] {
  return sh('git', ['ls-tree', '--name-only', '-r', ref], repoDir)
    .split('\n')
    .filter((line) => line.length > 0);
}

async function makeRemoteOnlyMergeRepo(): Promise<{
  localRepoDir: string;
  mergeSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'p1-revert-remote-'));
  tempRoots.push(root);

  const remoteDir = join(root, 'origin.git');
  const localRepoDir = join(root, 'repo');

  sh('git', ['init', '--bare', remoteDir], root);
  sh('git', ['init', '-b', 'main', localRepoDir], root);
  sh('git', ['config', 'user.email', 'test@test.com'], localRepoDir);
  sh('git', ['config', 'user.name', 'Test'], localRepoDir);
  sh('git', ['remote', 'add', 'origin', remoteDir], localRepoDir);

  await writeFile(join(localRepoDir, 'README.md'), '# test\n');
  sh('git', ['add', 'README.md'], localRepoDir);
  sh('git', ['commit', '-m', 'init'], localRepoDir);
  sh('git', ['push', '-u', 'origin', 'main'], localRepoDir);

  // Build the squash merge locally, push it to origin, then rewind the local
  // main so the merge commit exists ONLY on the remote trunk.
  sh('git', ['checkout', '-b', 'feature/remote-only'], localRepoDir);
  await writeFile(join(localRepoDir, 'first.txt'), 'first\n');
  sh('git', ['add', 'first.txt'], localRepoDir);
  sh('git', ['commit', '-m', 'feature first'], localRepoDir);
  await writeFile(join(localRepoDir, 'second.txt'), 'second\n');
  sh('git', ['add', 'second.txt'], localRepoDir);
  sh('git', ['commit', '-m', 'feature second'], localRepoDir);

  sh('git', ['checkout', 'main'], localRepoDir);
  sh('git', ['merge', '--squash', 'feature/remote-only'], localRepoDir);
  sh('git', ['commit', '-m', 'squash landing'], localRepoDir);
  sh('git', ['push', 'origin', 'main'], localRepoDir);

  const mergeSha = sh('git', ['rev-parse', 'HEAD'], localRepoDir);

  // The daemon-side local repo must not have the merge SHA locally.
  sh('git', ['reset', '--hard', 'origin/main~1'], localRepoDir);

  return { localRepoDir, mergeSha };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-uuid-42',
    issueNumber: 42,
    title: 'Ship gated lane change',
    phase: 'integrate',
    variant: 'spec-driven',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    repoOwner: 'DANIELSOCRAHANDLEZZ',
    repoName: 'auto-claude',
    deploymentId: 'auto-claude',
    startedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    workerClaimId: 'claim-g4',
    ...overrides,
  };
}

describe('revert-lane real-remote regressions', () => {
  it('fetches the remote trunk before reverting a squash merge SHA that only exists on origin', async () => {
    const { localRepoDir, mergeSha } = await makeRemoteOnlyMergeRepo();

    const raisedRequests: DecisionRequest[] = [];
    const pullsCreate = vi.fn(async () => ({
      data: {
        number: 91,
        html_url: 'https://github.com/DANIELSOCRAHANDLEZZ/auto-claude/pull/91',
      },
    }));

    await handlePostLandingObservation({
      repoRoot: localRepoDir,
      owner: 'DANIELSOCRAHANDLEZZ',
      repo: 'auto-claude',
      deployment: 'auto-claude',
      run: makeRun(),
      trunkBranch: 'main',
      mergeSha,
      featureHeadSha: 'unused-in-this-test',
      revertBranch: 'revert/remote-only',
      observeTrunk: async () => ({
        status: 'red',
        summary: 'trunk checks red after landing',
      }),
      octokit: { pulls: { create: pullsCreate } },
      raiseDecisionRequest: async (request) => {
        raisedRequests.push(DecisionRequestSchema.parse(request));
      },
      now: FIXED_NOW,
    });

    expect(pullsCreate).toHaveBeenCalledTimes(1);
    expect(raisedRequests).toHaveLength(1);

    // The revert branch must exist locally and must revert exactly the remote merge SHA.
    expect(gitRefExists(localRepoDir, 'refs/heads/revert/remote-only')).toBe(true);
    const files = trackedFilesAt(localRepoDir, 'revert/remote-only');
    expect(files).toContain('README.md');
    expect(files).not.toContain('first.txt');
    expect(files).not.toContain('second.txt');

    const revertParent = sh(
      'git',
      ['rev-parse', 'revert/remote-only^'],
      localRepoDir,
    );
    expect(revertParent).toBe(mergeSha);
  });

  it('builds a schema-valid degraded escalation when the automated revert fails', () => {
    const request = buildDegradedReversalEscalationRequest({
      run: makeRun(),
      deployment: 'auto-claude',
      mergeSha: '1234567890abcdef1234567890abcdef12345678',
      error: 'git revert failed: conflict',
      now: FIXED_NOW,
    });

    const parsed = DecisionRequestSchema.parse(request);
    expect(parsed.phase).toBe('reversal-raised');
    expect(parsed.decision_id).toContain('reversal-failed');
    expect(parsed.context).toContain('git revert failed: conflict');
    expect(parsed.options.map((o) => o.id).sort()).toEqual(['approve', 'reject']);
  });
});
