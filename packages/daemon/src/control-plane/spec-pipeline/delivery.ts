// delivery.ts — Daemon-owned spec artifact delivery
// Governed by: STACK-AC-CONTROLLED-ARTIFACT-DELIVERY

import type { Octokit } from '@octokit/rest';
import { git } from '../../lib/git.js';
import { err, ok, type Result } from '../../lib/result.js';
import type {
  Phase,
  PhaseArtifact,
  PipelineFailureKind,
} from '../../types.js';

export type DeliverableSpecPhase = 'l2-design' | 'l3-generate';

export interface DeliveryRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  phase: DeliverableSpecPhase;
  workspacePath: string;
  baseBranch: string;
  octokit: Octokit;
}

export interface DeliveryResult {
  artifact: PhaseArtifact;
  changedPaths: string[];
  reusedProposal: boolean;
}

export type ArtifactReconcileStatus =
  | 'proposed'
  | 'awaiting-review'
  | 'merged'
  | 'rejected';

export interface ArtifactReconcileRequest {
  owner: string;
  repo: string;
  phase: DeliverableSpecPhase;
  artifact?: PhaseArtifact;
  repoRoot: string;
  octokit: Octokit;
}

export interface ArtifactMergeRequest extends ArtifactReconcileRequest {
  commitTitle: string;
  commitMessage?: string;
}

export interface ArtifactReconcileResult {
  artifact: PhaseArtifact;
  status: ArtifactReconcileStatus;
  resumeRef?: string;
}

export class DeliveryError extends Error {
  kind: PipelineFailureKind;

  constructor(kind: PipelineFailureKind, message: string) {
    super(message);
    this.name = 'DeliveryError';
    this.kind = kind;
  }
}

type PullRequestRecord = {
  number?: number;
  html_url?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  head?: { ref?: string };
  base?: { ref?: string };
};

export async function deliverPhaseArtifact(
  request: DeliveryRequest,
): Promise<Result<DeliveryResult>> {
  const proposalKey = buildProposalKey(request);
  const headBranch = buildHeadBranch(request.phase, request.issueNumber);
  const existing = await findExistingProposal(request, proposalKey, headBranch);
  if (!existing.ok) return existing;

  const changedPathsResult = await getChangedPaths(request.workspacePath);
  if (!changedPathsResult.ok) return changedPathsResult;
  const changedPaths = changedPathsResult.value;

  if (changedPaths.length === 0) {
    if (existing.value) {
      return ok({
        artifact: toArtifact(request, proposalKey, headBranch, existing.value, []),
        changedPaths: [],
        reusedProposal: true,
      });
    }
    return err(
      new DeliveryError(
        'agent-output-invalid',
        `No changed artifacts found for ${request.phase}`,
      ),
    );
  }

  const outOfScope = changedPaths.filter(
    (path) => !isAllowedArtifactPath(request.phase, path),
  );
  if (outOfScope.length > 0) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Out-of-scope artifact changes for ${request.phase}: ${outOfScope.join(', ')}`,
      ),
    );
  }

  if (existing.value && existing.value.state !== 'open') {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Existing ${request.phase} proposal #${existing.value.number ?? 'unknown'} is not open and cannot be updated`,
      ),
    );
  }

  const prepared = await prepareDeliveryCommit(
    request,
    headBranch,
    changedPaths,
  );
  if (!prepared.ok) return prepared;

  const proposal = existing.value
    ? await updateProposal(request, proposalKey, headBranch, existing.value)
    : await createProposal(request, proposalKey, headBranch);
  if (!proposal.ok) return proposal;

  return ok({
    artifact: toArtifact(request, proposalKey, headBranch, proposal.value, changedPaths),
    changedPaths,
    reusedProposal: existing.value !== undefined,
  });
}

export async function reconcilePhaseArtifact(
  request: ArtifactReconcileRequest,
): Promise<Result<ArtifactReconcileResult>> {
  const proposal = await loadProposalByArtifact(request);
  if (!proposal.ok) return proposal;
  return reconcileProposalRecord(request, proposal.value);
}

export async function mergePhaseArtifact(
  request: ArtifactMergeRequest,
): Promise<Result<ArtifactReconcileResult>> {
  const proposal = await loadProposalByArtifact(request);
  if (!proposal.ok) return proposal;

  const currentStatus = proposalStatus(proposal.value);
  if (currentStatus === 'merged') {
    return reconcileProposalRecord(request, proposal.value);
  }
  if (currentStatus !== 'awaiting-review') {
    return ok({
      artifact: updateArtifactFromProposal(request.artifact, proposal.value),
      status: currentStatus,
    });
  }

  const pullNumber = request.artifact?.pullRequestNumber;
  if (pullNumber === undefined) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Recorded ${request.phase} artifact has no pull request number`,
      ),
    );
  }

  try {
    const response = await request.octokit.pulls.merge({
      owner: request.owner,
      repo: request.repo,
      pull_number: pullNumber,
      merge_method: 'squash',
      commit_title: request.commitTitle,
      commit_message: request.commitMessage,
    });
    const data = response.data as { sha?: string };
    const mergeSha = data.sha;
    return reconcileProposalRecord(request, {
      ...proposal.value,
      state: 'closed',
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha:
        mergeSha !== undefined && mergeSha.length > 0
          ? mergeSha
          : proposal.value.merge_commit_sha,
    });
  } catch (e) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to merge ${request.phase} proposal #${pullNumber}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

export function buildProposalKey(request: {
  owner: string;
  repo: string;
  issueNumber: number;
  phase: Phase;
  baseBranch: string;
}): string {
  return `${request.owner}/${request.repo}#${request.issueNumber}:${request.phase}:${request.baseBranch}`;
}

export function buildHeadBranch(
  phase: DeliverableSpecPhase,
  issueNumber: number,
): string {
  return phase === 'l2-design'
    ? `spec/l2/${issueNumber}`
    : `spec/l3/${issueNumber}`;
}

async function findExistingProposal(
  request: DeliveryRequest,
  proposalKey: string,
  headBranch: string,
): Promise<Result<PullRequestRecord | undefined>> {
  try {
    const response = await request.octokit.pulls.list({
      owner: request.owner,
      repo: request.repo,
      state: 'all',
      head: `${request.owner}:${headBranch}`,
      base: request.baseBranch,
      per_page: 20,
    });
    const matches = (response.data as PullRequestRecord[]).filter((pr) =>
      (pr.body ?? '').includes(proposalMarker(proposalKey)),
    );
    if (matches.length > 1) {
      return err(
        new DeliveryError(
          'delivery-repair-needed',
          `Multiple proposals found for ${proposalKey}`,
        ),
      );
    }
    return ok(matches[0]);
  } catch (e) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to find existing proposal: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

async function getChangedPaths(
  workspacePath: string,
): Promise<Result<string[]>> {
  const status = await git(['status', '--porcelain=v1', '-uall'], workspacePath);
  if (!status.ok) return status;
  return ok(
    status.value
      .split('\n')
      .map((line) => parsePorcelainPath(line))
      .filter((path): path is string => path !== undefined),
  );
}

async function prepareDeliveryCommit(
  request: DeliveryRequest,
  headBranch: string,
  changedPaths: string[],
): Promise<Result<void>> {
  const checkout = await git(['checkout', '-B', headBranch], request.workspacePath);
  if (!checkout.ok) return checkout;

  const add = await git(['add', '--', ...changedPaths], request.workspacePath);
  if (!add.ok) return add;

  const commit = await git(
    [
      'commit',
      '-m',
      `${phaseTitle(request.phase)} artifacts for #${request.issueNumber}`,
    ],
    request.workspacePath,
  );
  if (!commit.ok) return commit;

  const push = await git(
    ['push', '--force-with-lease', '-u', 'origin', headBranch],
    request.workspacePath,
  );
  if (!push.ok) return push;

  return ok(undefined);
}

async function loadProposalByArtifact(
  request: ArtifactReconcileRequest,
): Promise<Result<PullRequestRecord>> {
  const artifact = request.artifact;
  if (artifact === undefined) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `No recorded ${request.phase} artifact found for reconciliation`,
      ),
    );
  }
  if (artifact.pullRequestNumber === undefined) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Recorded ${request.phase} artifact has no pull request number`,
      ),
    );
  }
  try {
    const response = await request.octokit.pulls.get({
      owner: request.owner,
      repo: request.repo,
      pull_number: artifact.pullRequestNumber,
    });
    return ok(response.data as PullRequestRecord);
  } catch (e) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to load ${request.phase} proposal #${artifact.pullRequestNumber}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

async function reconcileProposalRecord(
  request: ArtifactReconcileRequest,
  proposal: PullRequestRecord,
): Promise<Result<ArtifactReconcileResult>> {
  const artifact = updateArtifactFromProposal(request.artifact, proposal);
  const status = proposalStatus(proposal);
  if (status !== 'merged') {
    return ok({ artifact, status });
  }

  const verified = await verifyMergedOnBase(request.repoRoot, artifact);
  if (!verified.ok) return err(verified.error);
  return ok({ artifact, status, resumeRef: verified.value });
}

async function verifyMergedOnBase(
  repoRoot: string,
  artifact: PhaseArtifact,
): Promise<Result<string>> {
  const mergeIdentifier = artifact.mergeIdentifier;
  if (mergeIdentifier === undefined || mergeIdentifier.length === 0) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Merged ${artifact.phase} artifact is missing a merge identifier`,
      ),
    );
  }

  const fetch = await git(['fetch', 'origin', artifact.baseBranch], repoRoot);
  if (!fetch.ok) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to fetch ${artifact.baseBranch} before artifact reconciliation: ${fetch.error.message}`,
      ),
    );
  }

  const resumeRef = `origin/${artifact.baseBranch}`;
  const verified = await git(
    ['merge-base', '--is-ancestor', mergeIdentifier, resumeRef],
    repoRoot,
  );
  if (!verified.ok) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Merged ${artifact.phase} artifact ${mergeIdentifier} is not present on ${resumeRef}: ${verified.error.message}`,
      ),
    );
  }
  return ok(resumeRef);
}

async function createProposal(
  request: DeliveryRequest,
  proposalKey: string,
  headBranch: string,
): Promise<Result<PullRequestRecord>> {
  try {
    const response = await request.octokit.pulls.create({
      owner: request.owner,
      repo: request.repo,
      head: headBranch,
      base: request.baseBranch,
      title: proposalTitle(request),
      body: proposalBody(request, proposalKey),
    });
    return ok(response.data as PullRequestRecord);
  } catch (e) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to create proposal: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

async function updateProposal(
  request: DeliveryRequest,
  proposalKey: string,
  headBranch: string,
  proposal: PullRequestRecord,
): Promise<Result<PullRequestRecord>> {
  if (proposal.number === undefined) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Existing proposal for ${proposalKey} has no number`,
      ),
    );
  }
  try {
    const response = await request.octokit.pulls.update({
      owner: request.owner,
      repo: request.repo,
      pull_number: proposal.number,
      title: proposalTitle(request),
      body: proposalBody(request, proposalKey),
      base: request.baseBranch,
    });
    return ok({
      ...(response.data as PullRequestRecord),
      head: { ref: headBranch },
      base: { ref: request.baseBranch },
    });
  } catch (e) {
    return err(
      new DeliveryError(
        'delivery-repair-needed',
        `Failed to update proposal #${proposal.number}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

function toArtifact(
  request: DeliveryRequest,
  proposalKey: string,
  headBranch: string,
  proposal: PullRequestRecord,
  changedPaths: string[],
): PhaseArtifact {
  const now = new Date().toISOString();
  return {
    issueNumber: request.issueNumber,
    phase: request.phase,
    artifactKind: 'pull_request',
    proposalKey,
    artifactPaths: changedPaths,
    headBranch: proposal.head?.ref ?? headBranch,
    baseBranch: proposal.base?.ref ?? request.baseBranch,
    pullRequestNumber: proposal.number,
    pullRequestUrl: proposal.html_url,
    status: proposalStatus(proposal),
    createdAt: proposal.created_at ?? now,
    updatedAt: proposal.updated_at ?? now,
    mergeIdentifier: proposal.merge_commit_sha ?? undefined,
  };
}

function updateArtifactFromProposal(
  artifact: PhaseArtifact | undefined,
  proposal: PullRequestRecord,
): PhaseArtifact {
  if (artifact === undefined) {
    throw new DeliveryError(
      'delivery-repair-needed',
      'Cannot update missing phase artifact from proposal',
    );
  }
  const now = new Date().toISOString();
  return {
    ...artifact,
    headBranch: proposal.head?.ref ?? artifact.headBranch,
    baseBranch: proposal.base?.ref ?? artifact.baseBranch,
    pullRequestNumber: proposal.number ?? artifact.pullRequestNumber,
    pullRequestUrl: proposal.html_url ?? artifact.pullRequestUrl,
    status: proposalStatus(proposal),
    createdAt: proposal.created_at ?? artifact.createdAt,
    updatedAt: proposal.updated_at ?? now,
    mergeIdentifier: proposal.merge_commit_sha ?? artifact.mergeIdentifier,
  };
}

function proposalStatus(proposal: PullRequestRecord): ArtifactReconcileStatus {
  const mergedAt = proposal.merged_at;
  if (
    proposal.merged === true ||
    (mergedAt !== undefined && mergedAt !== null && mergedAt.length > 0)
  ) {
    return 'merged';
  }
  if (proposal.state === 'closed') return 'rejected';
  if (proposal.state === 'open') return 'awaiting-review';
  return 'proposed';
}

function isAllowedArtifactPath(
  phase: DeliverableSpecPhase,
  path: string,
): boolean {
  if (path === '.specify/traceability.yml') return true;
  if (phase === 'l2-design') return path.startsWith('.specify/architecture/');
  return path.startsWith('.specify/stack/');
}

export function parsePorcelainPath(line: string): string | undefined {
  if (!line.trim()) return undefined;
  // Porcelain v1 is "XY <path>" — two status columns then a single space.
  // runCommand() .trim()s command output, which strips the LEADING space of an
  // unstaged-modified (" M …") first line, turning "XY path" into "Y path". A
  // fixed slice(3) then eats the first char of the path (".specify" -> "specify"),
  // which silently fails the artifact-scope check for traceability.yml on every
  // l2/l3 run. Strip ≤2 status chars + the one separator space instead, so the
  // parse is correct whether or not the line was left-trimmed.
  const rawPath = line.replace(/^.{0,2}[ \t]/, '');
  const renameIndex = rawPath.indexOf(' -> ');
  return renameIndex === -1 ? rawPath : rawPath.slice(renameIndex + 4);
}

function proposalTitle(request: DeliveryRequest): string {
  return `${phaseTitle(request.phase)} for #${request.issueNumber}: ${request.issueTitle}`;
}

function phaseTitle(phase: DeliverableSpecPhase): string {
  return phase === 'l2-design' ? 'L2 spec' : 'L3 spec';
}

function proposalBody(request: DeliveryRequest, proposalKey: string): string {
  return [
    proposalMarker(proposalKey),
    '',
    `Daemon-owned ${phaseTitle(request.phase)} delivery for #${request.issueNumber}.`,
    '',
    `Base branch: ${request.baseBranch}`,
    `Phase: ${request.phase}`,
  ].join('\n');
}

function proposalMarker(proposalKey: string): string {
  return `<!-- runforge-proposal-key: ${proposalKey} -->`;
}
