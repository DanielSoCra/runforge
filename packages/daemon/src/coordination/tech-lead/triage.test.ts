// packages/daemon/src/coordination/tech-lead/triage.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchUntriagedIssues } from './triage.js';

function makeOctokit(issues: Array<{ number: number; title: string; body: string | null; labels: Array<{ name: string }>; pull_request?: unknown }>) {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: issues }),
    },
  } as unknown as import('@octokit/rest').Octokit;
}

describe('fetchUntriagedIssues', () => {
  it('returns review-finding issues missing tl-triaged label', async () => {
    const octokit = makeOctokit([
      { number: 1, title: 'A', body: 'body A', labels: [{ name: 'review-finding' }, { name: 'P2' }] },
      { number: 2, title: 'B', body: 'body B', labels: [{ name: 'review-finding' }, { name: 'tl-triaged' }] },
      { number: 3, title: 'C', body: 'body C', labels: [{ name: 'review-finding' }] },
    ]);

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 5);

    expect(octokit.issues.listForRepo).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      labels: 'review-finding',
      state: 'open',
      per_page: 100,
      page: 1,
    });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.issueNumber)).toEqual([1, 3]);
    expect(result[0]!.severity).toBe('P2');
  });

  it('excludes pull requests', async () => {
    const octokit = makeOctokit([
      { number: 1, title: 'PR', body: null, labels: [{ name: 'review-finding' }], pull_request: {} },
      { number: 2, title: 'Issue', body: null, labels: [{ name: 'review-finding' }] },
    ]);

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 5);

    expect(result).toHaveLength(1);
    expect(result[0]!.issueNumber).toBe(2);
  });

  it('respects the cap', async () => {
    const octokit = makeOctokit([
      { number: 1, title: 'A', body: null, labels: [{ name: 'review-finding' }] },
      { number: 2, title: 'B', body: null, labels: [{ name: 'review-finding' }] },
      { number: 3, title: 'C', body: null, labels: [{ name: 'review-finding' }] },
    ]);

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 2);

    expect(result).toHaveLength(2);
  });

  it('returns empty array when cap is zero', async () => {
    const octokit = makeOctokit([
      { number: 1, title: 'A', body: null, labels: [{ name: 'review-finding' }] },
    ]);

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 0);

    expect(result).toEqual([]);
    expect(octokit.issues.listForRepo).not.toHaveBeenCalled();
  });

  it('paginates past a fully-triaged first page to find untriaged issues on later pages', async () => {
    // Page 1 is a full page (100) of already-triaged issues; the untriaged
    // findings only appear on page 2. A single-page fetch would miss them.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `triaged ${i + 1}`,
      body: null,
      labels: [{ name: 'review-finding' }, { name: 'tl-triaged' }],
    }));
    const page2 = [
      { number: 101, title: 'fresh A', body: null, labels: [{ name: 'review-finding' }] },
      { number: 102, title: 'fresh B', body: null, labels: [{ name: 'review-finding' }] },
    ];

    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const octokit = { issues: { listForRepo } } as unknown as import('@octokit/rest').Octokit;

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 5);

    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(listForRepo).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, per_page: 100 }));
    expect(listForRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, per_page: 100 }));
    expect(result.map((i) => i.issueNumber)).toEqual([101, 102]);
  });

  it('stops paginating once the cap is satisfied', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `finding ${i + 1}`,
      body: null,
      labels: [{ name: 'review-finding' }],
    }));
    const listForRepo = vi.fn().mockResolvedValue({ data: fullPage });
    const octokit = { issues: { listForRepo } } as unknown as import('@octokit/rest').Octokit;

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 2);

    // First page already yields >= cap untriaged issues, so no second request.
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
  });

  it('returns empty array on API error', async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockRejectedValue(new Error('API error')),
      },
    } as unknown as import('@octokit/rest').Octokit;

    const result = await fetchUntriagedIssues({ octokit, owner: 'o', repo: 'r' }, 5);

    expect(result).toEqual([]);
  });
});
