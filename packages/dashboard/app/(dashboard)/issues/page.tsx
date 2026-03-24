// packages/dashboard/app/(dashboard)/issues/page.tsx
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { classifyIssues, type RunRecord, type GitHubIssue } from '@/lib/classify-issues';
import { IssuesBoard } from '@/components/issues-board';

export const dynamic = 'force-dynamic';

interface RepoRow {
  id: string;
  owner: string;
  name: string;
  connection_id: string | null;
}

async function fetchIssuesForRepo(
  owner: string,
  name: string,
  token: string | undefined,
): Promise<{ issues: GitHubIssue[]; error: string | null }> {
  if (!token) return { issues: [], error: `No GitHub token for ${owner}/${name}` };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/issues?state=open&per_page=100`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        next: { revalidate: 0 },
      },
    );
    if (!res.ok) return { issues: [], error: `GitHub API error ${res.status} for ${owner}/${name}` };
    const data = await res.json() as GitHubIssue[];
    // GitHub issues endpoint returns PRs too — filter them out
    return { issues: data.filter((i) => !('pull_request' in i)), error: null };
  } catch {
    return { issues: [], error: `Failed to fetch issues for ${owner}/${name}` };
  }
}

export default async function IssuesPage() {
  const supabase = await createClient();

  const [{ data: repos }, { data: runs }] = await Promise.all([
    supabase.from('repos').select('id, owner, name, connection_id').eq('enabled', true).is('deleted_at', null),
    supabase.from('runs').select('issue_number, repo_owner, repo_name, issue_title, outcome, current_phase').order('started_at', { ascending: false }),
  ]);

  const repoList = (repos ?? []) as RepoRow[];
  const runList = (runs ?? []) as RunRecord[];

  // Spec: "If no enabled repos have a GitHub token, the board shows an empty-state prompt pointing to Settings."
  if (repoList.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Issues</h1>
          <p className="text-muted-foreground text-sm">Open issues across enabled repos</p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-sm text-muted-foreground mb-3">No enabled repos found.</p>
          <a
            href="/settings"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go to Settings
          </a>
        </div>
      </div>
    );
  }

  // Fetch token + issues per repo in parallel, tracking whether each repo has a token
  const service = createServiceClient();
  const repoIssueResults = await Promise.all(
    repoList.map(async (repo) => {
      let token: string | undefined;
      if (repo.connection_id) {
        // Service role required — decrypt_github_token has REVOKE EXECUTE FROM PUBLIC
        const { data } = await service.rpc('decrypt_github_token', { p_connection_id: repo.connection_id });
        token = (data as string | null) ?? process.env.GITHUB_TOKEN;
      } else {
        token = process.env.GITHUB_TOKEN;
      }
      const hasToken = !!token;
      const { issues, error } = await fetchIssuesForRepo(repo.owner, repo.name, token);
      return { owner: repo.owner, name: repo.name, issues, error, hasToken };
    }),
  );

  const allReposLackToken = repoIssueResults.every((r) => !r.hasToken);
  if (allReposLackToken) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Issues</h1>
          <p className="text-muted-foreground text-sm">Open issues across enabled repos</p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
          <p className="text-sm text-muted-foreground mb-3">
            None of your enabled repos have a GitHub token configured.
          </p>
          <a
            href="/settings"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go to Settings
          </a>
        </div>
      </div>
    );
  }

  const fetchErrors = repoIssueResults.filter((r) => r.error !== null).map((r) => r.error!);
  const repoIssues = repoIssueResults.map(({ owner, name, issues }) => ({ owner, name, issues }));
  const cards = classifyIssues(repoIssues, runList);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Issues</h1>
        <p className="text-muted-foreground text-sm">
          Open issues across {repoList.length} enabled {repoList.length === 1 ? 'repo' : 'repos'}
        </p>
      </div>
      {fetchErrors.length > 0 && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive space-y-1">
          {fetchErrors.map((e) => <p key={e}>{e}</p>)}
        </div>
      )}
      <IssuesBoard cards={cards} />
    </div>
  );
}
