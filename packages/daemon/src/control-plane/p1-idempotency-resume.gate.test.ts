// Rationale: G5 pins PR adoption and the extended artifact-status runtime contract without static missing-module imports.
import { describe, expect, it, vi } from 'vitest';

const PR_DELIVERY_MODULE_PATH = './pr-delivery.js';
const PHASE_ARTIFACT_STATUS_MODULE_PATH = './phase-artifact-status.js';

interface PullRequestSummary {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

interface PullsListParams {
  owner: string;
  repo: string;
  state: 'open';
  head: string;
}

interface PullsCreateParams {
  owner: string;
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

interface PullsMergeParams {
  owner: string;
  repo: string;
  pull_number: number;
  merge_method: 'squash';
}

interface AwaitRequiredChecksArgs {
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
}

type AwaitRequiredChecksResult =
  | { status: 'green' }
  | { status: 'red'; reason?: string }
  | { status: 'timeout'; reason?: string }
  | { status: 'no-required-checks'; reason?: string };

interface DeliveryArgs {
  octokit: unknown;
  owner: string;
  repo: string;
  featureBranch: string;
  landsOn: string;
  requiredChecks: string[];
  phaseArtifact: {
    issueNumber: number;
    phase: 'integrate';
    artifactKind: 'pull_request';
    proposalKey: string;
    artifactPaths: string[];
    headBranch: string;
    baseBranch: string;
    pullRequestNumber?: number;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  awaitRequiredChecks: (args: AwaitRequiredChecksArgs) => Promise<AwaitRequiredChecksResult>;
  pushFeatureBranch: () => Promise<unknown>;
  trigger: { kind: 'operator-approved-epoch'; detail: string };
}

type DeliverCodeChangeViaPR = (args: DeliveryArgs) => Promise<unknown>;
type IsKnownPhaseArtifactStatus = (status: string) => boolean;

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadModule(modulePath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(modulePath)) as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    return { __loadError: error };
  }
}

async function loadDeliverCodeChangeViaPR(): Promise<DeliverCodeChangeViaPR> {
  const moduleExports = await loadModule(PR_DELIVERY_MODULE_PATH);
  const deliver = moduleExports.deliverCodeChangeViaPR as DeliverCodeChangeViaPR | undefined;
  expect(
    deliver,
    `deliverCodeChangeViaPR must be exported from ${PR_DELIVERY_MODULE_PATH}; load error: ${formatUnknownError(moduleExports.__loadError)}`,
  ).toBeTypeOf('function');
  return deliver!;
}

async function loadStatusGuard(): Promise<IsKnownPhaseArtifactStatus> {
  const moduleExports = await loadModule(PHASE_ARTIFACT_STATUS_MODULE_PATH);
  const guard = moduleExports.isKnownPhaseArtifactStatus as IsKnownPhaseArtifactStatus | undefined;
  expect(
    guard,
    `isKnownPhaseArtifactStatus must be exported from ${PHASE_ARTIFACT_STATUS_MODULE_PATH}; load error: ${formatUnknownError(moduleExports.__loadError)}`,
  ).toBeTypeOf('function');
  return guard!;
}

function makeOctokitWithExistingPull(existingPull: PullRequestSummary) {
  return {
    pulls: {
      list: vi.fn(async (_params: PullsListParams): Promise<{ data: PullRequestSummary[] }> => ({
        data: [existingPull],
      })),
      create: vi.fn(async (_params: PullsCreateParams): Promise<{ data: PullRequestSummary }> => {
        throw new Error('duplicate PR creation is forbidden when an open ProposalKey match exists');
      }),
      merge: vi.fn(async (_params: PullsMergeParams): Promise<{ data: { merged: true; sha: string } }> => ({
        data: { merged: true, sha: 'adopted-pr-squash-sha' },
      })),
    },
  };
}

function makeArgs(overrides: Partial<DeliveryArgs> = {}): DeliveryArgs {
  const owner = 'octo-org';
  const repo = 'auto-claude';
  const featureBranch = 'feature/p1-resume';
  const landsOn = 'staging';

  return {
    octokit: makeOctokitWithExistingPull({
      number: 654,
      html_url: 'https://github.example/pull/654',
      head: { ref: featureBranch },
      base: { ref: landsOn },
    }),
    owner,
    repo,
    featureBranch,
    landsOn,
    requiredChecks: ['daemon / test'],
    phaseArtifact: {
      issueNumber: 42,
      phase: 'integrate',
      artifactKind: 'pull_request',
      proposalKey: `${owner}/${repo}#42:integrate:${landsOn}:${featureBranch}`,
      artifactPaths: [],
      headBranch: featureBranch,
      baseBranch: landsOn,
      status: 'prepared',
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    },
    awaitRequiredChecks: vi.fn(async (): Promise<AwaitRequiredChecksResult> => ({ status: 'green' })),
    pushFeatureBranch: vi.fn(async (): Promise<{ skipped: true }> => ({ skipped: true })),
    trigger: { kind: 'operator-approved-epoch', detail: 'resume after operator approval' },
    ...overrides,
  };
}

describe('G5 PR idempotency and resume', () => {
  it('adopts an existing open PR for the ProposalKey instead of creating a duplicate PR', async () => {
    const deliver = await loadDeliverCodeChangeViaPR();
    const existingPull = {
      number: 654,
      html_url: 'https://github.example/pull/654',
      head: { ref: 'feature/p1-resume' },
      base: { ref: 'staging' },
    };
    const octokit = makeOctokitWithExistingPull(existingPull);

    const result = await deliver(
      makeArgs({
        octokit,
      }),
    );

    expect(octokit.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        state: 'open',
        head: 'octo-org:feature/p1-resume',
      }),
    );
    expect(octokit.pulls.create).not.toHaveBeenCalled();
    expect(octokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        pull_number: 654,
        merge_method: 'squash',
      }),
    );
    expect(result).toMatchObject({
      merged: true,
      prNumber: 654,
      mergeSha: 'adopted-pr-squash-sha',
    });
  });

  it('accepts the extended integrate phase artifact statuses needed for resume', async () => {
    // No runtime PhaseArtifactStatus schema exists today, so this gate expects a dynamic status guard boundary.
    const isKnownPhaseArtifactStatus = await loadStatusGuard();
    const statuses = [
      'joined',
      'observed-healthy',
      'observed-red',
      'reversal-raised',
      'reverted',
    ] as const;

    for (const status of statuses) {
      const integrateArtifact = {
        issueNumber: 42,
        phase: 'integrate',
        artifactKind: 'pull_request',
        proposalKey: `octo-org/auto-claude#42:integrate:${status}`,
        artifactPaths: [],
        headBranch: 'feature/p1-resume',
        baseBranch: 'staging',
        pullRequestNumber: 654,
        status,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      };

      expect(
        isKnownPhaseArtifactStatus(integrateArtifact.status),
        `${status} must be accepted as a resume-driving PhaseArtifact status`,
      ).toBe(true);
    }
  });
});
