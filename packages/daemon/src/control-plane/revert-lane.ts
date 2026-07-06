// packages/daemon/src/control-plane/revert-lane.ts
//
// Post-landing observation + fail-closed auto-revert lane. After a controlled
// code-change merge, observe the trunk on the squash merge SHA. On red or
// indeterminate, revert that SHA on a fresh branch, push, open a revert PR, and
// raise a dedicated approve/reject reversal DecisionRequest.
//
// This module is the live revert path; the legacy coordination/merge-agent.ts
// scaffolding is quarantined and must not be treated as a rollback net.

import {
  DecisionRequestSchema,
  type DecisionRequest,
} from '@runforge/decision-protocol';
import type { RunState } from '../types.js';
import { git } from '../lib/git.js';

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrunkObservation {
  status: 'healthy' | 'red' | 'indeterminate';
  summary: string;
}

export interface ObserveTrunkInput {
  repoRoot: string;
  trunkBranch: string;
  mergeSha: string;
}

export interface BuildReversalDecisionRequestInput {
  run: RunState;
  deployment: string;
  mergeSha: string;
  revertBranch: string;
  gateIssueUrl: string;
  pullRequestUrl: string;
  now: string;
}

export interface HandlePostLandingObservationInput {
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
      create: (params: {
        owner: string;
        repo: string;
        head: string;
        base: string;
        title: string;
        body: string;
      }) => Promise<{ data: { number: number; html_url: string } }>;
    };
  };
  raiseDecisionRequest: (request: unknown) => Promise<void>;
  now: string;
}

export function buildReversalDecisionId(run: RunState, mergeSha: string): string {
  const runRef = `issue-${run.issueNumber}`;
  const epoch = run.mergeDecisionEpoch ?? 1;
  return `${runRef}:reversal-raised:${epoch}:${mergeSha.slice(0, 8)}`;
}

/**
 * Build a dedicated approve/reject reversal DecisionRequest. The wire verbs stay
 * {approve, reject}: approve merges the revert PR; reject holds the revert and
 * escalates to a human.
 */
export function buildReversalDecisionRequest({
  run,
  deployment,
  mergeSha,
  revertBranch,
  gateIssueUrl,
  pullRequestUrl,
  now,
}: BuildReversalDecisionRequestInput): DecisionRequest {
  const runRef = `issue-${run.issueNumber}`;
  const decisionId = buildReversalDecisionId(run, mergeSha);
  const nowIso = now;
  const expiresAt = new Date(
    new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS,
  ).toISOString();

  const context = [
    `Run ${runRef} landed on ${mergeSha} and the trunk observation is red or indeterminate.`,
    `Deployment: "${deployment}". Revert branch: ${revertBranch}. Revert PR: ${pullRequestUrl}.`,
    `Approve merges the revert PR and undoes the landing; reject holds the revert for human review.`,
  ].join(' ');

  const request = {
    decision_id: decisionId,
    source_url: gateIssueUrl,
    deployment,
    run_id: runRef,
    worker_session_id: run.workerClaimId ?? `run-${run.issueNumber}`,
    phase: 'reversal-raised',
    risk_class: 'P1' as const,
    question: `Approve reverting ${mergeSha} — trunk checks went red?`,
    context,
    options: [
      { id: 'approve', label: 'Approve the revert and undo the landing.' },
      { id: 'reject', label: 'Reject the revert and hold for human review.' },
    ],
    consequence_of_no_answer:
      'The revert stays pending and the trunk remains potentially red until decided.',
    reversibility: 'reversible' as const,
    expires_at: expiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
  };

  return DecisionRequestSchema.parse(request);
}

export interface BuildDegradedReversalEscalationInput {
  run: RunState;
  deployment: string;
  mergeSha: string;
  error: string;
  now: string;
}

/**
 * Build a degraded escalation DecisionRequest for when the automated revert
 * itself failed (git conflict, push reject, or index unavailable). The trunk is
 * red and the operator must intervene manually.
 */
export function buildDegradedReversalEscalationRequest({
  run,
  deployment,
  mergeSha,
  error,
  now,
}: BuildDegradedReversalEscalationInput): DecisionRequest {
  const runRef = `issue-${run.issueNumber}`;
  const epoch = run.mergeDecisionEpoch ?? 1;
  const decisionId = `${runRef}:reversal-failed:${epoch}:${mergeSha.slice(0, 8)}`;
  const nowIso = now;
  const expiresAt = new Date(
    new Date(nowIso).getTime() + DEFAULT_EXPIRY_MS,
  ).toISOString();

  const context = [
    `Run ${runRef} landed on ${mergeSha} and the trunk observation is red or indeterminate.`,
    `Deployment: "${deployment}". The automated revert failed: ${error}`,
    `Manual intervention is required — approve to acknowledge, reject to hold for review.`,
  ].join(' ');

  const request = {
    decision_id: decisionId,
    source_url: `https://github.com/${run.repoOwner ?? 'unknown-owner'}/${run.repoName ?? 'unknown-repo'}/issues/${run.issueNumber}`,
    deployment,
    run_id: runRef,
    worker_session_id: run.workerClaimId ?? `run-${run.issueNumber}`,
    phase: 'reversal-raised',
    risk_class: 'P1' as const,
    question: `Automated revert failed for ${mergeSha} — manual intervention required?`,
    context,
    options: [
      { id: 'approve', label: 'Acknowledge and queue for manual revert.' },
      { id: 'reject', label: 'Reject and hold for human review.' },
    ],
    consequence_of_no_answer:
      'The red trunk remains un-reverted until an Operator intervenes.',
    reversibility: 'reversible' as const,
    expires_at: expiresAt,
    answer_schema: { kind: 'option' as const },
    resume_mode: 'requeue' as const,
    idempotency_key: decisionId,
  };

  return DecisionRequestSchema.parse(request);
}

/**
 * Observe the trunk after a controlled landing. On healthy, do nothing. On red
 * or indeterminate (fail-closed), revert the squash merge SHA, open a revert PR,
 * and raise a dedicated reversal DecisionRequest.
 */
export async function handlePostLandingObservation({
  repoRoot,
  owner,
  repo,
  deployment,
  run,
  trunkBranch,
  mergeSha,
  revertBranch,
  observeTrunk,
  octokit,
  raiseDecisionRequest,
  now,
}: HandlePostLandingObservationInput): Promise<
  | { action: 'none'; observation: TrunkObservation }
  | {
      action: 'reversal-raised';
      observation: TrunkObservation;
      prNumber: number;
      prUrl: string;
      decisionId: string;
    }
> {
  const observation = await observeTrunk({ repoRoot, trunkBranch, mergeSha });

  if (observation.status === 'healthy') {
    return { action: 'none', observation };
  }

  // Fail-closed: red or indeterminate triggers the revert lane.
  // The squash merge commit exists only on the remote trunk after the API merge;
  // fetch the remote trunk and reset the local tracking branch to it so the
  // merge SHA is reachable before we try to revert it.
  const fetchRemote = await git(['fetch', 'origin', trunkBranch], repoRoot);
  if (!fetchRemote.ok) {
    throw new Error(
      `failed to fetch origin/${trunkBranch} before revert: ${fetchRemote.error.message}`,
    );
  }

  const checkout = await git(
    ['checkout', '-B', trunkBranch, `origin/${trunkBranch}`],
    repoRoot,
  );
  if (!checkout.ok) {
    throw new Error(
      `failed to checkout ${trunkBranch} before revert: ${checkout.error.message}`,
    );
  }

  const branch = await git(['checkout', '-b', revertBranch], repoRoot);
  if (!branch.ok) {
    throw new Error(
      `failed to create revert branch ${revertBranch}: ${branch.error.message}`,
    );
  }

  const revert = await git(['revert', '--no-edit', mergeSha], repoRoot);
  if (!revert.ok) {
    throw new Error(`git revert of ${mergeSha} failed: ${revert.error.message}`);
  }

  const push = await git(['push', 'origin', revertBranch], repoRoot);
  if (!push.ok) {
    throw new Error(
      `failed to push revert branch ${revertBranch}: ${push.error.message}`,
    );
  }

  const title = `Revert landing ${mergeSha.slice(0, 8)}`;
  const body = [
    `<!-- runforge-reversal: ${mergeSha} -->`,
    '',
    `Automatic revert of landing ${mergeSha} because trunk observation is ${observation.status}.`,
  ].join('\n');

  const pr = await octokit.pulls.create({
    owner,
    repo,
    head: revertBranch,
    base: trunkBranch,
    title,
    body,
  });

  const request = buildReversalDecisionRequest({
    run,
    deployment,
    mergeSha,
    revertBranch,
    gateIssueUrl: `https://github.com/${owner}/${repo}/issues/${run.issueNumber}`,
    pullRequestUrl: pr.data.html_url,
    now,
  });

  await raiseDecisionRequest(request);

  return {
    action: 'reversal-raised',
    observation,
    prNumber: pr.data.number,
    prUrl: pr.data.html_url,
    decisionId: request.decision_id,
  };
}
