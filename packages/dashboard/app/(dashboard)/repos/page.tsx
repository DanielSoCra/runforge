import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BudgetBadge } from '@/components/budget-badge';
import Link from 'next/link';
import { Plus, AlertTriangle } from 'lucide-react';
import { PageError } from '@/components/page-error';
import { ImportReposModal } from '@/components/import-repos-modal';
import { getDashboardStores } from '@/lib/data/stores';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const repositoryList = await getDashboardStores().repositories.listRepositories();
  if (!repositoryList.ok) {
    console.error('[repos] failed to load repos:', repositoryList.message);
    return <PageError />;
  }
  const { activeCostByRepoId, connections, repos } = repositoryList.value;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage monitored repositories</p>
        </div>
        <div className="flex gap-2">
          {connections.map((conn) => (
            <ImportReposModal
              key={conn.id}
              connectionId={conn.id}
              connectionName={conn.display_name}
              importedRepos={repos
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
        {repos.map((repo) => {
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
                    totalCost={activeCostByRepoId[repo.id] ?? 0}
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
        {repos.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories yet. Import from GitHub or <Link href="/repos/new" className="underline">add manually</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
