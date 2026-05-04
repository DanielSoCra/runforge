import { createClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BudgetBadge } from '@/components/budget-badge';
import Link from 'next/link';
import { Plus, AlertTriangle } from 'lucide-react';
import { PageError } from '@/components/page-error';
import { ImportReposModal } from '@/components/import-repos-modal';

export default async function ReposPage() {
  const supabase = await createClient();
  const [
    { data: repos, error: reposError },
    { data: connections },
    { data: activeRuns, error: runsError },
  ] = await Promise.all([
    supabase
      .from('repos')
      .select('*, github_connections(display_name, github_login)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.from('github_connections').select('id, display_name, github_login, status').order('created_at'),
    supabase.from('runs').select('repo_id, total_cost').eq('outcome', 'in-progress'),
  ]);
  if (reposError) {
    console.error('[repos] failed to load repos:', reposError);
    return <PageError />;
  }
  if (runsError) {
    console.error('[repos] failed to load active run budgets:', runsError);
  }

  const activeCostByRepoId = new Map<string, number>();
  for (const run of activeRuns ?? []) {
    if (!run.repo_id) continue;
    const cost = Number(run.total_cost ?? 0);
    const current = activeCostByRepoId.get(run.repo_id) ?? 0;
    if (cost > current) activeCostByRepoId.set(run.repo_id, cost);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage monitored repositories</p>
        </div>
        <div className="flex gap-2">
          {connections?.map((conn) => (
            <ImportReposModal
              key={conn.id}
              connectionId={conn.id}
              connectionName={conn.display_name}
              importedRepos={(repos ?? [])
                .filter((r) => r.connection_id === conn.id)
                .map((r) => ({ id: r.id, owner: r.owner, name: r.name, enabled: r.enabled }))}
            />
          ))}
          <Button asChild variant="outline">
            <Link href="/repos/new"><Plus className="h-4 w-4 mr-2" />Add manually</Link>
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        {repos?.map((repo) => {
          const conn = repo.github_connections as { display_name: string; github_login: string } | null;
          return (
            <Card key={repo.id} className="hover:border-border/80 transition-colors">
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-medium">{repo.owner}/{repo.name}</span>
                  <Badge variant={repo.enabled ? 'default' : 'secondary'}>
                    {repo.enabled ? 'active' : 'disabled'}
                  </Badge>
                  <BudgetBadge
                    totalCost={activeCostByRepoId.get(repo.id) ?? 0}
                    budgetLimit={repo.budget_limit == null ? null : Number(repo.budget_limit)}
                  />
                  {conn && (
                    <Badge variant="outline" className="text-xs">{conn.display_name}</Badge>
                  )}
                  {repo.github_status === 'not_found' && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" />not found on GitHub
                    </Badge>
                  )}
                  {repo.credential_status === 'error' && (
                    <Badge
                      variant="destructive"
                      className="gap-1"
                      title={repo.credential_error ?? 'Credential decryption failed'}
                    >
                      <AlertTriangle className="h-3 w-3" />credential error
                    </Badge>
                  )}
                  {!conn && !repo.connection_id && (
                    <span className="text-xs text-muted-foreground">manual</span>
                  )}
                  {repo.connection_id && !conn && (
                    <Badge variant="secondary" className="text-xs">disconnected</Badge>
                  )}
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/repos/${repo.id}`}>Configure →</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
        {(!repos || repos.length === 0) && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories yet. Import from GitHub or <Link href="/repos/new" className="underline">add manually</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
