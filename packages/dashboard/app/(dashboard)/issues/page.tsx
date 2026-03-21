// packages/dashboard/app/(dashboard)/issues/page.tsx
import { createClient } from '@/lib/supabase/server';
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
    supabase.from('runs').select('issue_number, repo_owner, repo_name, issue_title, outcome, current_phase').order('started_at', { ascending: false }).limit(200),
  ]);

  const repoList = (repos ?? []) as RepoRow[];
  const runList = (runs ?? []) as RunRecord[];

  // Fetch token + issues per repo in parallel
  const repoIssueResults = await Promise.all(
    repoList.map(async (repo) => {
      let token: string | undefined;
      if (repo.connection_id) {
        const { data } = await supabase.rpc('decrypt_github_token', { p_connection_id: repo.connection_id });
        token = (data as string | null) ?? process.env.GITHUB_TOKEN;
      } else {
        token = process.env.GITHUB_TOKEN;
      }
      const { issues, error } = await fetchIssuesForRepo(repo.owner, repo.name, token);
      return { owner: repo.owner, name: repo.name, issues, error };
    }),
  );

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
