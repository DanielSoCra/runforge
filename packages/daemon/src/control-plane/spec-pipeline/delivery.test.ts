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
  type DeliveryRequest,
} from './delivery.js';

type TestOctokit = {
  pulls: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
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
  return {
    pulls: {
      list: vi.fn().mockResolvedValue({ data: existing }),
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
