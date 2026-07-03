// Rationale: G2 pins the PR-gated delivery lane without statically importing missing P1 modules.
import { describe, expect, it, vi } from 'vitest';

const PR_DELIVERY_MODULE_PATH = './pr-delivery.js';

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

interface PushFeatureBranchArgs {
  owner: string;
  repo: string;
  featureBranch: string;
  landsOn: string;
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
  pushFeatureBranch: (args: PushFeatureBranchArgs) => Promise<unknown>;
  trigger: { kind: 'auto-merge' | 'operator-approved-epoch'; detail: string };
}

type DeliverCodeChangeViaPR = (args: DeliveryArgs) => Promise<unknown>;

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadPrDeliveryModule(): Promise<Record<string, unknown>> {
  try {
    return (await import(PR_DELIVERY_MODULE_PATH)) as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    return { __loadError: error };
  }
}

async function loadDeliverCodeChangeViaPR(): Promise<DeliverCodeChangeViaPR> {
  const moduleExports = await loadPrDeliveryModule();
  const deliver = moduleExports.deliverCodeChangeViaPR as DeliverCodeChangeViaPR | undefined;
  expect(
    deliver,
    `deliverCodeChangeViaPR must be exported from ${PR_DELIVERY_MODULE_PATH}; load error: ${formatUnknownError(moduleExports.__loadError)}`,
  ).toBeTypeOf('function');
  return deliver!;
}

function makeOctokit(options: { existingPulls?: PullRequestSummary[]; prNumber?: number; mergeSha?: string } = {}) {
  const existingPulls = options.existingPulls ?? [];
  const prNumber = options.prNumber ?? 101;
  const mergeSha = options.mergeSha ?? 'squash-merge-sha-101';

  return {
    pulls: {
      list: vi.fn(async (_params: PullsListParams): Promise<{ data: PullRequestSummary[] }> => ({
        data: existingPulls,
      })),
      create: vi.fn(async (_params: PullsCreateParams): Promise<{ data: PullRequestSummary }> => ({
        data: {
          number: prNumber,
          html_url: `https://github.example/pull/${prNumber}`,
          head: { ref: 'feature/p1-pr-delivery' },
          base: { ref: 'staging' },
        },
      })),
      merge: vi.fn(async (_params: PullsMergeParams): Promise<{ data: { merged: true; sha: string } }> => ({
        data: { merged: true, sha: mergeSha },
      })),
    },
  };
}

function makeArgs(overrides: Partial<DeliveryArgs> = {}): DeliveryArgs {
  const owner = 'octo-org';
  const repo = 'auto-claude';
  const featureBranch = 'feature/p1-pr-delivery';
  const landsOn = 'staging';

  return {
    octokit: makeOctokit(),
    owner,
    repo,
    featureBranch,
    landsOn,
    requiredChecks: ['daemon / test', 'daemon / typecheck'],
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
    // G3 is covered elsewhere; this gate injects an awaitRequiredChecks-shaped fake.
    awaitRequiredChecks: vi.fn(async (): Promise<AwaitRequiredChecksResult> => ({ status: 'green' })),
    pushFeatureBranch: vi.fn(async (): Promise<{ pushed: true }> => ({ pushed: true })),
    trigger: { kind: 'auto-merge', detail: 'merge decision returned auto-merge' },
    ...overrides,
  };
}

describe('G2 deliverCodeChangeViaPR', () => {
  it('pushes, creates a PR, waits for green required checks, squash-merges, and returns the merge SHA', async () => {
    const deliver = await loadDeliverCodeChangeViaPR();
    const octokit = makeOctokit({ prNumber: 101, mergeSha: 'squash-sha-from-api' });
    const awaitRequiredChecks = vi.fn(async (): Promise<AwaitRequiredChecksResult> => ({ status: 'green' }));
    const pushFeatureBranch = vi.fn(async (): Promise<{ pushed: true }> => ({ pushed: true }));

    const result = await deliver(
      makeArgs({
        octokit,
        awaitRequiredChecks,
        pushFeatureBranch,
      }),
    );

    // ProposalKey idempotency is exercised through pulls.list({ state: 'open', head: '<owner>:<featureBranch>' }).
    expect(octokit.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        state: 'open',
        head: 'octo-org:feature/p1-pr-delivery',
      }),
    );
    const listOrder = octokit.pulls.list.mock.invocationCallOrder[0] ?? -1;
    const createOrder = octokit.pulls.create.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(listOrder).toBeLessThan(createOrder);
    expect(pushFeatureBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        featureBranch: 'feature/p1-pr-delivery',
        landsOn: 'staging',
      }),
    );
    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        base: 'staging',
        head: 'feature/p1-pr-delivery',
      }),
    );
    expect(awaitRequiredChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        ref: 'feature/p1-pr-delivery',
        requiredChecks: ['daemon / test', 'daemon / typecheck'],
      }),
    );
    expect(octokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octo-org',
        repo: 'auto-claude',
        pull_number: 101,
        merge_method: 'squash',
      }),
    );
    expect(result).toMatchObject({
      merged: true,
      prNumber: 101,
      mergeSha: 'squash-sha-from-api',
    });
  });

  it('creates or adopts the PR but never merges when required checks are red', async () => {
    const deliver = await loadDeliverCodeChangeViaPR();
    const octokit = makeOctokit({ prNumber: 202 });
    const awaitRequiredChecks = vi.fn(async (): Promise<AwaitRequiredChecksResult> => ({
      status: 'red',
      reason: 'daemon / test failed',
    }));

    const result = await deliver(
      makeArgs({
        octokit,
        awaitRequiredChecks,
      }),
    );

    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        base: 'staging',
        head: 'feature/p1-pr-delivery',
      }),
    );
    expect(octokit.pulls.merge).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      merged: false,
      prNumber: 202,
    });
  });

  it('uses the same PR delivery lane for auto-merge decisions and operator-approved epoch re-entry', async () => {
    const deliver = await loadDeliverCodeChangeViaPR();

    for (const trigger of [
      { kind: 'auto-merge' as const, detail: "decision.kind === 'auto-merge'" },
      { kind: 'operator-approved-epoch' as const, detail: 'mergeDecisionApprovedEpoch re-entry' },
    ]) {
      const octokit = makeOctokit({ prNumber: 303, mergeSha: 'same-lane-squash-sha' });

      const result = await deliver(
        makeArgs({
          octokit,
          trigger,
        }),
      );

      expect(octokit.pulls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          base: 'staging',
          head: 'feature/p1-pr-delivery',
        }),
      );
      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          pull_number: 303,
          merge_method: 'squash',
        }),
      );
      expect(result).toMatchObject({
        merged: true,
        prNumber: 303,
        mergeSha: 'same-lane-squash-sha',
      });
    }
  });
});
