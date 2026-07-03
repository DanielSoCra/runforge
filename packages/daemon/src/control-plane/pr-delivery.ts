// packages/daemon/src/control-plane/pr-delivery.ts
//
// ProposalKey-idempotent PR delivery for code changes. Push the feature branch,
// adopt or create the PR, await required checks, and squash-merge on green.
// The same lane serves auto-merge verdicts and operator-approved-epoch re-entry.
// Never throws — failures return `{ merged: false, ... }` so the caller can park.

import type { PhaseArtifact } from '../types.js';
import type { AwaitRequiredChecksArgs } from './await-checks.js';

export interface DeliverCodeChangeViaPRArgs {
  octokit: {
    pulls: {
      list: (params: {
        owner: string;
        repo: string;
        state: 'open' | 'all';
        head: string;
      }) => Promise<{
        data: Array<{
          number: number;
          html_url: string;
          head: { ref: string };
          base: { ref: string };
          merged?: boolean;
          merge_commit_sha?: string | null;
        }>;
      }>;
      create: (params: {
        owner: string;
        repo: string;
        base: string;
        head: string;
        title: string;
        body: string;
      }) => Promise<{
        data: {
          number: number;
          html_url: string;
          head: { ref: string };
          base: { ref: string };
        };
      }>;
      merge: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        merge_method: 'squash';
      }) => Promise<{ data: { merged: boolean; sha: string } }>;
    };
  };
  owner: string;
  repo: string;
  featureBranch: string;
  landsOn: string;
  requiredChecks: string[];
  phaseArtifact: PhaseArtifact;
  awaitRequiredChecks: (args: Omit<AwaitRequiredChecksArgs, 'octokit'>) => Promise<
    | { status: 'green'; reason?: string }
    | { status: 'red'; reason?: string }
    | { status: 'timeout'; reason?: string }
    | { status: 'no-required-checks'; reason?: string }
  >;
  pushFeatureBranch: (args: {
    owner: string;
    repo: string;
    featureBranch: string;
    landsOn: string;
  }) => Promise<unknown>;
  trigger: { kind: 'auto-merge' | 'operator-approved-epoch'; detail: string };
  /** Internal seam: when true the PR is opened/adopted but never merged. */
  skipMerge?: boolean;
}

export interface DeliverCodeChangeViaPRResult {
  merged: boolean;
  prNumber?: number;
  mergeSha?: string;
  reason?: string;
}

function proposalMarker(proposalKey: string): string {
  return `<!-- auto-claude-proposal-key: ${proposalKey} -->`;
}

function proposalTitle(issueNumber: number): string {
  return `Integrate code change for #${issueNumber}`;
}

function proposalBody(
  issueNumber: number,
  proposalKey: string,
  phase: string,
  baseBranch: string,
): string {
  return [
    proposalMarker(proposalKey),
    '',
    `Daemon-owned code-change delivery for #${issueNumber}.`,
    '',
    `Phase: ${phase}`,
    `Base branch: ${baseBranch}`,
  ].join('\n');
}

/**
 * Deliver a code change by PR: idempotently adopt or create the proposal, push
 * the feature branch, poll named required checks, and squash-merge on green.
 */
export async function deliverCodeChangeViaPR({
  octokit,
  owner,
  repo,
  featureBranch,
  landsOn,
  requiredChecks,
  phaseArtifact,
  awaitRequiredChecks,
  pushFeatureBranch,
  skipMerge = false,
}: DeliverCodeChangeViaPRArgs): Promise<DeliverCodeChangeViaPRResult> {
  try {
    const now = new Date().toISOString();

    // 1. ProposalKey idempotency: search open PRs by head before creating one.
    const openList = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${featureBranch}`,
    });
    let existing = openList.data.find(
      (pr) => pr.head.ref === featureBranch && pr.base.ref === landsOn,
    );

    // An already-merged PR (e.g., crash after API merge but before observation)
    // is not in the open list, so fall back to searching all pull requests.
    if (existing === undefined) {
      const allList = await octokit.pulls.list({
        owner,
        repo,
        state: 'all',
        head: `${owner}:${featureBranch}`,
      });
      const closed = allList.data.find(
        (pr) => pr.head.ref === featureBranch && pr.base.ref === landsOn,
      );
      if (
        closed !== undefined &&
        closed.merged === true &&
        closed.merge_commit_sha !== undefined &&
        closed.merge_commit_sha !== null &&
        closed.merge_commit_sha !== ''
      ) {
        phaseArtifact.pullRequestNumber = closed.number;
        phaseArtifact.pullRequestUrl = closed.html_url;
        phaseArtifact.baseBranch = landsOn;
        phaseArtifact.status = 'joined';
        phaseArtifact.mergeIdentifier = closed.merge_commit_sha;
        phaseArtifact.mergeSha = closed.merge_commit_sha;
        phaseArtifact.updatedAt = now;
        return {
          merged: true,
          prNumber: closed.number,
          mergeSha: closed.merge_commit_sha,
        };
      }
      existing = closed;
    }

    let prNumber: number;
    let prUrl: string;
    if (existing !== undefined) {
      prNumber = existing.number;
      prUrl = existing.html_url;
    } else {
      const pushResult = await pushFeatureBranch({
        owner,
        repo,
        featureBranch,
        landsOn,
      });
      if (
        pushResult !== null &&
        typeof pushResult === 'object' &&
        'pushed' in pushResult &&
        pushResult.pushed === false
      ) {
        const errorMessage =
          'error' in pushResult && typeof pushResult.error === 'string'
            ? pushResult.error
            : 'unknown error';
        return {
          merged: false,
          reason: `feature branch push failed: ${errorMessage}`,
        };
      }
      const created = await octokit.pulls.create({
        owner,
        repo,
        base: landsOn,
        head: featureBranch,
        title: proposalTitle(phaseArtifact.issueNumber),
        body: proposalBody(
          phaseArtifact.issueNumber,
          phaseArtifact.proposalKey,
          phaseArtifact.phase,
          landsOn,
        ),
      });
      prNumber = created.data.number;
      prUrl = created.data.html_url;
    }

    phaseArtifact.pullRequestNumber = prNumber;
    phaseArtifact.pullRequestUrl = prUrl;
    phaseArtifact.baseBranch = landsOn;
    phaseArtifact.status = 'awaiting-review';
    phaseArtifact.updatedAt = new Date().toISOString();

    if (skipMerge) {
      return { merged: false, prNumber, reason: 'merge skipped — decision is hold/escalate' };
    }

    // 2. Wait for required checks.
    const checkResult = await awaitRequiredChecks({
      owner,
      repo,
      ref: featureBranch,
      requiredChecks,
    });

    if (checkResult.status !== 'green') {
      return {
        merged: false,
        prNumber,
        reason: checkResult.reason ?? `checks ${checkResult.status}`,
      };
    }

    // 3. Squash-merge.
    const mergeResponse = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: 'squash',
    });

    phaseArtifact.status = 'joined';
    phaseArtifact.mergeIdentifier = mergeResponse.data.sha;
    phaseArtifact.mergeSha = mergeResponse.data.sha;
    phaseArtifact.updatedAt = new Date().toISOString();

    return {
      merged: true,
      prNumber,
      mergeSha: mergeResponse.data.sha,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { merged: false, reason };
  }
}
