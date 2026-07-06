// G4 gate: red/indeterminate post-landing observations revert the squash merge SHA and raise a dedicated approve/reject reversal decision.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  DecisionRequestSchema,
  type DecisionRequest,
} from '@runforge/decision-protocol';
import type { RunState } from '../types.js';

const FIXED_NOW = '2026-07-03T12:00:00.000Z';

type ObservationStatus = 'healthy' | 'red' | 'indeterminate';

interface ObserveTrunkInput {
  repoRoot: string;
  trunkBranch: string;
  mergeSha: string;
}

interface TrunkObservation {
  status: ObservationStatus;
  summary: string;
}

interface PullsCreateInput {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

interface PullsCreateResult {
  data: {
    number: number;
    html_url: string;
  };
}

interface LandingRepo {
  repoDir: string;
  mergeSha: string;
  featureHeadSha: string;
}

interface FlowFakes {
  observeTrunk: (input: ObserveTrunkInput) => Promise<TrunkObservation>;
  pullsCreate: ReturnType<typeof vi.fn<(input: PullsCreateInput) => Promise<PullsCreateResult>>>;
  octokit: {
    pulls: {
      create: (input: PullsCreateInput) => Promise<PullsCreateResult>;
    };
  };
  raiseDecisionRequest: (request: unknown) => Promise<void>;
  raisedRequests: DecisionRequest[];
}

type BuildReversalDecisionRequest = (input: {
  run: RunState;
  deployment: string;
  mergeSha: string;
  revertBranch: string;
  gateIssueUrl: string;
  pullRequestUrl: string;
  now: string;
}) => unknown;

type HandlePostLandingObservation = (input: {
  repoRoot: string;
  owner: string;
  repo: string;
  deployment: string;
  run: RunState;
  trunkBranch: string;
  mergeSha: string;
  featureHeadSha: string;
  revertBranch: string;
  observeTrunk: (input: ObserveTrunkInput) => Promise<TrunkObservation>;
  octokit: {
    pulls: {
      create: (input: PullsCreateInput) => Promise<PullsCreateResult>;
    };
  };
  raiseDecisionRequest: (request: unknown) => Promise<void>;
  now: string;
}) => Promise<unknown>;

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

async function makeSquashLandedRepo(): Promise<LandingRepo> {
  const root = await mkdtemp(join(tmpdir(), 'p1-revert-lane-'));
  tempRoots.push(root);

  const repoDir = join(root, 'repo');
  const remoteDir = join(root, 'origin.git');

  sh('git', ['init', '--bare', remoteDir], root);
  sh('git', ['init', '-b', 'main', repoDir], root);
  sh('git', ['config', 'user.email', 'test@test.com'], repoDir);
  sh('git', ['config', 'user.name', 'Test'], repoDir);
  sh('git', ['remote', 'add', 'origin', remoteDir], repoDir);

  await writeFile(join(repoDir, 'README.md'), '# test\n');
  sh('git', ['add', 'README.md'], repoDir);
  sh('git', ['commit', '-m', 'init'], repoDir);
  sh('git', ['push', '-u', 'origin', 'main'], repoDir);

  sh('git', ['checkout', '-b', 'feature/g4-target'], repoDir);
  await writeFile(join(repoDir, 'first.txt'), 'first feature commit\n');
  sh('git', ['add', 'first.txt'], repoDir);
  sh('git', ['commit', '-m', 'feature first'], repoDir);
  await writeFile(join(repoDir, 'second.txt'), 'second feature commit\n');
  sh('git', ['add', 'second.txt'], repoDir);
  sh('git', ['commit', '-m', 'feature second'], repoDir);

  const featureHeadSha = sh('git', ['rev-parse', 'HEAD'], repoDir);

  sh('git', ['checkout', 'main'], repoDir);
  sh('git', ['merge', '--squash', 'feature/g4-target'], repoDir);
  sh('git', ['commit', '-m', 'squash landing'], repoDir);

  const mergeSha = sh('git', ['rev-parse', 'HEAD'], repoDir);
  expect(mergeSha).not.toBe(featureHeadSha);

  sh('git', ['push', 'origin', 'main'], repoDir);

  return { repoDir, mergeSha, featureHeadSha };
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
    repoName: 'runforge',
    deploymentId: 'runforge',
    startedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    workerClaimId: 'claim-g4',
    ...overrides,
  };
}

function makeFakes(status: ObservationStatus): FlowFakes {
  const raisedRequests: DecisionRequest[] = [];

  const observeTrunk = vi.fn(async (input: ObserveTrunkInput): Promise<TrunkObservation> => ({
    status,
    summary: `${status} at ${input.mergeSha}`,
  }));

  const pullsCreate = vi.fn(async (_input: PullsCreateInput): Promise<PullsCreateResult> => ({
    data: {
      number: 91,
      html_url: 'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/91',
    },
  }));

  const raiseDecisionRequest = vi.fn(async (request: unknown): Promise<void> => {
    raisedRequests.push(DecisionRequestSchema.parse(request));
  });

  return {
    observeTrunk,
    pullsCreate,
    octokit: { pulls: { create: pullsCreate } },
    raiseDecisionRequest,
    raisedRequests,
  };
}

async function loadRevertLaneExport<T>(exportName: string): Promise<T> {
  const modulePath: string = './revert-lane.js';
  const moduleRecord = (await import(modulePath)) as Record<string, unknown>;
  const exported = moduleRecord[exportName];

  expect(exported, `${exportName} must be exported by revert-lane.ts`).toBeTypeOf('function');

  return exported as T;
}

function expectReversalDecisionForMergeSha(
  request: DecisionRequest,
  mergeSha: string,
  expectedSourceUrl = 'https://github.com/DANIELSOCRAHANDLEZZ/runforge/issues/42',
): DecisionRequest {
  const parsed = DecisionRequestSchema.parse(request);
  const optionIds = parsed.options.map((option) => option.id);

  expect(optionIds).toHaveLength(2);
  expect([...new Set(optionIds)].sort()).toEqual(['approve', 'reject']);
  expect(parsed.answer_schema).toEqual({ kind: 'option' });
  expect(parsed.phase).toBe('reversal-raised');
  expect(parsed.decision_id).toContain('reversal');
  expect(parsed.decision_id).not.toContain(':integrate:');
  expect(`${parsed.question} ${parsed.context}`).toContain(mergeSha);
  expect(parsed.source_url).toBe(expectedSourceUrl);

  return parsed;
}

function expectOneRaisedRequest(raisedRequests: DecisionRequest[]): DecisionRequest {
  expect(raisedRequests).toHaveLength(1);
  const request = raisedRequests[0];
  if (request === undefined) {
    throw new Error('expected exactly one raised DecisionRequest');
  }
  return request;
}

function expectBranchRevertedMergeSha(repo: LandingRepo, revertBranch: string): void {
  const files = trackedFilesAt(repo.repoDir, revertBranch);
  expect(files).toContain('README.md');
  expect(files).not.toContain('first.txt');
  expect(files).not.toContain('second.txt');

  const revertParent = sh('git', ['rev-parse', `${revertBranch}^`], repo.repoDir);
  expect(revertParent).toBe(repo.mergeSha);

  const message = sh('git', ['show', '-s', '--format=%B', revertBranch], repo.repoDir);
  expect(message).toContain(repo.mergeSha);
  expect(message).not.toContain(repo.featureHeadSha);
}

async function exerciseReversalFlow(
  status: 'red' | 'indeterminate',
  revertBranch: string,
): Promise<void> {
  const handlePostLandingObservation =
    await loadRevertLaneExport<HandlePostLandingObservation>('handlePostLandingObservation');
  const repo = await makeSquashLandedRepo();
  const fakes = makeFakes(status);

  await handlePostLandingObservation({
    repoRoot: repo.repoDir,
    owner: 'DANIELSOCRAHANDLEZZ',
    repo: 'runforge',
    deployment: 'runforge',
    run: makeRun(),
    trunkBranch: 'main',
    mergeSha: repo.mergeSha,
    featureHeadSha: repo.featureHeadSha,
    revertBranch,
    observeTrunk: fakes.observeTrunk,
    octokit: fakes.octokit,
    raiseDecisionRequest: fakes.raiseDecisionRequest,
    now: FIXED_NOW,
  });

  expect(fakes.observeTrunk).toHaveBeenCalledWith(
    expect.objectContaining({
      repoRoot: repo.repoDir,
      trunkBranch: 'main',
      mergeSha: repo.mergeSha,
    }),
  );

  expectBranchRevertedMergeSha(repo, revertBranch);

  expect(fakes.pullsCreate).toHaveBeenCalledTimes(1);
  const firstPrCall = fakes.pullsCreate.mock.calls.at(0);
  expect(firstPrCall).toBeDefined();
  expect(firstPrCall?.[0]).toEqual(
    expect.objectContaining({
      owner: 'DANIELSOCRAHANDLEZZ',
      repo: 'runforge',
      head: revertBranch,
      base: 'main',
    }),
  );

  const request = expectOneRaisedRequest(fakes.raisedRequests);
  expectReversalDecisionForMergeSha(request, repo.mergeSha);
}

describe('P1 G4 post-landing revert lane', () => {
  it('builds a schema-valid dedicated reversal DecisionRequest with approve/reject wire options', async () => {
    const buildReversalDecisionRequest =
      await loadRevertLaneExport<BuildReversalDecisionRequest>('buildReversalDecisionRequest');
    const mergeSha = '1234567890abcdef1234567890abcdef12345678';

    const request = DecisionRequestSchema.parse(
      buildReversalDecisionRequest({
        run: makeRun(),
        deployment: 'runforge',
        mergeSha,
        revertBranch: 'revert/g4-schema',
        gateIssueUrl: 'https://github.com/DANIELSOCRAHANDLEZZ/runforge/issues/42',
        pullRequestUrl: 'https://github.com/DANIELSOCRAHANDLEZZ/runforge/pull/91',
        now: FIXED_NOW,
      }),
    );

    expectReversalDecisionForMergeSha(request, mergeSha);
  });

  it('red trunk observation reverts exactly the squash merge SHA, not the feature head, then opens a PR and raises reversal approval', async () => {
    await exerciseReversalFlow('red', 'revert/g4-red');
  });

  it('healthy trunk observation performs no revert, PR creation, or DecisionRequest raise', async () => {
    const handlePostLandingObservation =
      await loadRevertLaneExport<HandlePostLandingObservation>('handlePostLandingObservation');
    const repo = await makeSquashLandedRepo();
    const fakes = makeFakes('healthy');
    const revertBranch = 'revert/g4-healthy';

    await handlePostLandingObservation({
      repoRoot: repo.repoDir,
      owner: 'DANIELSOCRAHANDLEZZ',
      repo: 'runforge',
      deployment: 'runforge',
      run: makeRun(),
      trunkBranch: 'main',
      mergeSha: repo.mergeSha,
      featureHeadSha: repo.featureHeadSha,
      revertBranch,
      observeTrunk: fakes.observeTrunk,
      octokit: fakes.octokit,
      raiseDecisionRequest: fakes.raiseDecisionRequest,
      now: FIXED_NOW,
    });

    expect(fakes.observeTrunk).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: repo.repoDir,
        trunkBranch: 'main',
        mergeSha: repo.mergeSha,
      }),
    );
    expect(fakes.pullsCreate).not.toHaveBeenCalled();
    expect(fakes.raiseDecisionRequest).not.toHaveBeenCalled();
    expect(fakes.raisedRequests).toEqual([]);
    expect(gitRefExists(repo.repoDir, `refs/heads/${revertBranch}`)).toBe(false);
    expect(sh('git', ['rev-parse', 'main'], repo.repoDir)).toBe(repo.mergeSha);
    expect(trackedFilesAt(repo.repoDir, 'main')).toEqual(
      expect.arrayContaining(['README.md', 'first.txt', 'second.txt']),
    );
  });

  it('indeterminate trunk observation is fail-closed and triggers the same revert PR and reversal DecisionRequest as red', async () => {
    await exerciseReversalFlow('indeterminate', 'revert/g4-indeterminate');
  });
});
