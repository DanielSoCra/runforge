const GH_API = 'https://api.github.com';

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghFetch(token: string, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: headers(token) });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${(body as any)?.message ?? 'unknown'}`);
  }
  return body;
}

export interface CreateRepoOptions {
  org: string;
  name: string;
  description: string;
  private: boolean;
}

export interface GitHubRepo {
  id: number;
  name: string;
  html_url: string;
  full_name: string;
}

export async function createGitHubRepo(token: string, opts: CreateRepoOptions): Promise<GitHubRepo> {
  try {
    return await ghFetch(token, `${GH_API}/orgs/${opts.org}/repos`, {
      method: 'POST',
      body: JSON.stringify({
        name: opts.name,
        description: opts.description,
        private: opts.private,
        auto_init: false,
      }),
    }) as GitHubRepo;
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      // Before falling back to the user endpoint, verify opts.org is a personal account.
      // If the org doesn't exist at all, rethrow the original error.
      try {
        const userInfo = await ghFetch(token, `${GH_API}/users/${opts.org}`, { method: 'GET' }) as { type?: string };
        if (userInfo.type === 'User') {
          return await ghFetch(token, `${GH_API}/user/repos`, {
            method: 'POST',
            body: JSON.stringify({
              name: opts.name,
              description: opts.description,
              private: opts.private,
              auto_init: false,
            }),
          }) as GitHubRepo;
        }
      } catch {
        // User lookup failed — fall through to rethrow original error
      }
    }
    throw err;
  }
}

export interface CommitFileOptions {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  sha?: string; // for updates
}

export async function commitFile(token: string, opts: CommitFileOptions): Promise<void> {
  const encoded = Buffer.from(opts.content, 'utf8').toString('base64');
  await ghFetch(token, `${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${opts.path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: opts.message,
      content: encoded,
      ...(opts.sha ? { sha: opts.sha } : {}),
    }),
  });
}
