import { describe, it, expect, vi, beforeEach } from 'vitest';

global.fetch = vi.fn();

import { createGitHubRepo, commitFile } from './github-api';

const mockFetch = vi.mocked(fetch);

describe('createGitHubRepo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs to GitHub API with correct body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1, name: 'test-repo', html_url: 'https://github.com/acme/test-repo' }),
    } as Response);

    const result = await createGitHubRepo('ghp_token', {
      org: 'acme',
      name: 'test-repo',
      description: 'A test repo',
      private: true,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/orgs/acme/repos',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ghp_token' }),
      })
    );
    expect(result.html_url).toBe('https://github.com/acme/test-repo');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Repository creation failed' }),
    } as Response);

    await expect(
      createGitHubRepo('token', { org: 'acme', name: 'bad', description: '', private: false })
    ).rejects.toThrow('GitHub API error 422');
  });

  it('falls back to user repos endpoint when org endpoint returns 404 for a personal account', async () => {
    mockFetch
      // 1. POST /orgs/me/repos → 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      } as Response)
      // 2. GET /users/me → type: User (confirms personal account)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: 'User', login: 'me' }),
      } as Response)
      // 3. POST /user/repos → success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 2, name: 'my-repo', html_url: 'https://github.com/me/my-repo', full_name: 'me/my-repo' }),
      } as Response);

    const result = await createGitHubRepo('token', { org: 'me', name: 'my-repo', description: '', private: false });
    expect(result.html_url).toBe('https://github.com/me/my-repo');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2][0]).toBe('https://api.github.com/user/repos');
  });

  it('does not fall back when org 404 is for an unknown org (not a personal account)', async () => {
    mockFetch
      // 1. POST /orgs/unknown-org/repos → 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      } as Response)
      // 2. GET /users/unknown-org → type: Organization
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ type: 'Organization', login: 'unknown-org' }),
      } as Response);

    await expect(
      createGitHubRepo('token', { org: 'unknown-org', name: 'repo', description: '', private: false })
    ).rejects.toThrow('GitHub API error 404');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('commitFile', () => {
  it('PUTs file content to GitHub contents API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: { sha: 'abc' } }),
    } as Response);

    await commitFile('ghp_token', {
      owner: 'acme',
      repo: 'web',
      path: '.specify/L0-vision.md',
      content: '# Vision',
      message: 'chore: scaffold L0 vision',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/web/contents/.specify/L0-vision.md',
      expect.objectContaining({ method: 'PUT' })
    );
  });
});
