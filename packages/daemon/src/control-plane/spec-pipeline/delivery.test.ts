import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../lib/git.js';
import {
  buildHeadBranch,
  buildProposalKey,
  deliverPhaseArtifact,
  DeliveryError,
  mergePhaseArtifact,
  reconcilePhaseArtifact,
  type DeliveryRequest,
} from './delivery.js';
import type { PhaseArtifact } from '../../types.js';

type TestOctokit = {
  pulls: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    merge: ReturnType<typeof vi.fn>;
  };
};

async function makeRepo(): Promise<{
  repoRoot: string;
  remoteDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'artifact-delivery-'));
  const remoteDir = await mkdtemp(join(tmpdir(), 'artifact-delivery-remote-'));
  await git(['init', '-q', '-b', 'staging'], repoRoot);
  await git(['config', 'user.email', 'test@test'], repoRoot);
  await git(['config', 'user.name', 'test'], repoRoot);
  await mkdir(join(repoRoot, '.specify', 'architecture'), { recursive: true });
  await mkdir(join(repoRoot, '.specify', 'stack'), { recursive: true });
  await writeFile(join(repoRoot, '.specify', 'traceability.yml'), 'root: true\n');
  await git(['add', '.'], repoRoot);
  await git(['commit', '-q', '-m', 'init'], repoRoot);
  await git(['init', '-q', '--bare', '-b', 'staging'], remoteDir);
  await git(['remote', 'add', 'origin', remoteDir], repoRoot);
  await git(['push', '-q', '-u', 'origin', 'staging'], repoRoot);
  return {
    repoRoot,
    remoteDir,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    },
  };
}

function makeOctokit(existing: unknown[] = []): TestOctokit {
  const defaultProposal = {
    number: 12,
    html_url: 'https://github.example/pull/12',
    state: 'open',
    merged: false,
    head: { ref: 'spec/l2/42' },
    base: { ref: 'staging' },
    created_at: '2026-05-14T00:00:00Z',
    updated_at: '2026-05-14T00:00:00Z',
  };
  return {
    pulls: {
      list: vi.fn().mockResolvedValue({ data: existing }),
      get: vi.fn().mockResolvedValue({ data: existing[0] ?? defaultProposal }),
      create: vi.fn().mockResolvedValue({
        data: {
          number: 12,
          html_url: 'https://github.example/pull/12',
          state: 'open',
          merged: false,
          head: { ref: 'spec/l2/42' },
          base: { ref: 'staging' },
          created_at: '2026-05-14T00:00:00Z',
          updated_at: '2026-05-14T00:00:00Z',
        },
      }),
      update: vi.fn().mockResolvedValue({
        data: {
          number: 12,
          html_url: 'https://github.example/pull/12',
          state: 'open',
          merged: false,
          head: { ref: 'spec/l2/42' },
          base: { ref: 'staging' },
          created_at: '2026-05-14T00:00:00Z',
          updated_at: '2026-05-14T00:01:00Z',
        },
      }),
      merge: vi.fn().mockResolvedValue({ data: { sha: 'merge-sha' } }),
    },
  };
}

function makeRequest(
  repoRoot: string,
  octokit: ReturnType<typeof makeOctokit>,
  overrides: Partial<DeliveryRequest> = {},
): DeliveryRequest {
  return {
    owner: 'owner',
    repo: 'repo',
    issueNumber: 42,
    issueTitle: 'Build spec delivery',
    phase: 'l2-design',
    workspacePath: repoRoot,
    baseBranch: 'staging',
    octokit: octokit as unknown as DeliveryRequest['octokit'],
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<PhaseArtifact> = {}): PhaseArtifact {
  return {
    issueNumber: 42,
    phase: 'l2-design',
    artifactKind: 'pull_request',
    proposalKey: 'owner/repo#42:l2-design:staging',
    artifactPaths: ['.specify/architecture/new-arch.md'],
    headBranch: 'spec/l2/42',
    baseBranch: 'staging',
    pullRequestNumber: 12,
    pullRequestUrl: 'https://github.example/pull/12',
    status: 'awaiting-review',
    createdAt: '2026-05-14T00:00:00Z',
    updatedAt: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

describe('deliverPhaseArtifact', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it('creates a deterministic spec branch and pull request for L2 artifacts', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    await writeFile(
      join(repo.repoRoot, '.specify', 'architecture', 'new-arch.md'),
      'arch\n',
    );
    const octokit = makeOctokit();

    const result = await deliverPhaseArtifact(makeRequest(repo.repoRoot, octokit));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifact).toMatchObject({
      issueNumber: 42,
      phase: 'l2-design',
      artifactKind: 'pull_request',
      headBranch: 'spec/l2/42',
      baseBranch: 'staging',
      pullRequestNumber: 12,
      status: 'awaiting-review',
      artifactPaths: ['.specify/architecture/new-arch.md'],
    });
    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        base: 'staging',
        head: 'spec/l2/42',
        title: 'L2 spec for #42: Build spec delivery',
        body: expect.stringContaining(
          '<!-- auto-claude-proposal-key: owner/repo#42:l2-design:staging -->',
        ),
      }),
    );
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.repoRoot);
    expect(branch.ok ? branch.value.trim() : '').toBe('spec/l2/42');
  });

  it('updates an existing open proposal instead of creating a duplicate', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    await writeFile(join(repo.repoRoot, '.specify', 'stack', 'new-stack.md'), 'stack\n');
    const proposalKey = buildProposalKey({
      owner: 'owner',
      repo: 'repo',
      issueNumber: 42,
      phase: 'l3-generate',
      baseBranch: 'staging',
    });
    const octokit = makeOctokit([
      {
        number: 99,
        html_url: 'https://github.example/pull/99',
        state: 'open',
        merged: false,
        body: `<!-- auto-claude-proposal-key: ${proposalKey} -->`,
        head: { ref: 'spec/l3/42' },
        base: { ref: 'staging' },
      },
    ]);

    const result = await deliverPhaseArtifact(
      makeRequest(repo.repoRoot, octokit, { phase: 'l3-generate' }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.reusedProposal : false).toBe(true);
    expect(octokit.pulls.create).not.toHaveBeenCalled();
    expect(octokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 99,
        base: 'staging',
        title: 'L3 spec for #42: Build spec delivery',
      }),
    );
  });

  it('reuses an existing proposal when retry has no local changes', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    const proposalKey = buildProposalKey(makeRequest(repo.repoRoot, makeOctokit()));
    const octokit = makeOctokit([
      {
        number: 77,
        html_url: 'https://github.example/pull/77',
        state: 'open',
        merged: false,
        body: `<!-- auto-claude-proposal-key: ${proposalKey} -->`,
        head: { ref: 'spec/l2/42' },
        base: { ref: 'staging' },
      },
    ]);

    const result = await deliverPhaseArtifact(makeRequest(repo.repoRoot, octokit));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.changedPaths : []).toEqual([]);
    expect(octokit.pulls.create).not.toHaveBeenCalled();
    expect(octokit.pulls.update).not.toHaveBeenCalled();
  });

  it('rejects out-of-scope artifact changes', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    await writeFile(join(repo.repoRoot, 'README.md'), 'not a spec\n');
    const octokit = makeOctokit();

    const result = await deliverPhaseArtifact(makeRequest(repo.repoRoot, octokit));

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toBeInstanceOf(DeliveryError);
    expect(result.ok ? undefined : result.error.message).toContain(
      'Out-of-scope artifact changes',
    );
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it('reports agent-output-invalid when there are no changes and no proposal', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    const octokit = makeOctokit();

    const result = await deliverPhaseArtifact(makeRequest(repo.repoRoot, octokit));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DeliveryError);
      expect((result.error as DeliveryError).kind).toBe('agent-output-invalid');
    }
  });

  it('uses phase-specific source branches', () => {
    expect(buildHeadBranch('l2-design', 42)).toBe('spec/l2/42');
    expect(buildHeadBranch('l3-generate', 42)).toBe('spec/l3/42');
  });
});

describe('reconcilePhaseArtifact', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it('returns awaiting-review when the recorded proposal is still open', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    const octokit = makeOctokit();

    const result = await reconcilePhaseArtifact({
      owner: 'owner',
      repo: 'repo',
      phase: 'l2-design',
      artifact: makeArtifact(),
      repoRoot: repo.repoRoot,
      octokit: octokit as unknown as DeliveryRequest['octokit'],
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.status : undefined).toBe('awaiting-review');
    expect(octokit.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12 }),
    );
  });

  it('verifies a merged proposal is present on the target branch', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    await writeFile(
      join(repo.repoRoot, '.specify', 'architecture', 'merged.md'),
      'merged\n',
    );
    await git(['add', '.specify/architecture/merged.md'], repo.repoRoot);
    await git(['commit', '-q', '-m', 'merge l2'], repo.repoRoot);
    const sha = await git(['rev-parse', 'HEAD'], repo.repoRoot);
    expect(sha.ok).toBe(true);
    if (!sha.ok) return;
    await git(['push', '-q', 'origin', 'staging'], repo.repoRoot);
    const octokit = makeOctokit([
      {
        number: 12,
        html_url: 'https://github.example/pull/12',
        state: 'closed',
        merged: true,
        merged_at: '2026-05-14T00:05:00Z',
        merge_commit_sha: sha.value.trim(),
        head: { ref: 'spec/l2/42' },
        base: { ref: 'staging' },
      },
    ]);

    const result = await reconcilePhaseArtifact({
      owner: 'owner',
      repo: 'repo',
      phase: 'l2-design',
      artifact: makeArtifact(),
      repoRoot: repo.repoRoot,
      octokit: octokit as unknown as DeliveryRequest['octokit'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('merged');
    expect(result.value.resumeRef).toBe('origin/staging');
    expect(result.value.artifact.mergeIdentifier).toBe(sha.value.trim());
  });
});

describe('mergePhaseArtifact', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it('merges an open proposal and returns a verified resume ref', async () => {
    const repo = await makeRepo();
    cleanup = repo.cleanup;
    await writeFile(join(repo.repoRoot, '.specify', 'stack', 'merged.md'), 'merged\n');
    await git(['add', '.specify/stack/merged.md'], repo.repoRoot);
    await git(['commit', '-q', '-m', 'merge l3'], repo.repoRoot);
    const sha = await git(['rev-parse', 'HEAD'], repo.repoRoot);
    expect(sha.ok).toBe(true);
    if (!sha.ok) return;
    await git(['push', '-q', 'origin', 'staging'], repo.repoRoot);
    const octokit = makeOctokit([
      {
        number: 12,
        html_url: 'https://github.example/pull/12',
        state: 'open',
        merged: false,
        head: { ref: 'spec/l3/42' },
        base: { ref: 'staging' },
      },
    ]);
    octokit.pulls.merge.mockResolvedValueOnce({
      data: { sha: sha.value.trim() },
    });

    const result = await mergePhaseArtifact({
      owner: 'owner',
      repo: 'repo',
      phase: 'l3-generate',
      artifact: makeArtifact({
        phase: 'l3-generate',
        proposalKey: 'owner/repo#42:l3-generate:staging',
        artifactPaths: ['.specify/stack/merged.md'],
        headBranch: 'spec/l3/42',
      }),
      repoRoot: repo.repoRoot,
      octokit: octokit as unknown as DeliveryRequest['octokit'],
      commitTitle: 'L3 spec artifacts for #42',
      commitMessage: 'merge',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(octokit.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 12,
        merge_method: 'squash',
      }),
    );
    expect(result.value.status).toBe('merged');
    expect(result.value.resumeRef).toBe('origin/staging');
  });
});
