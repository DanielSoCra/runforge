import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { upsertApiKey } from '@/actions/api-keys';
import { enableRepo, disableRepo, deleteRepo, updateRepo } from '@/actions/repos';
import { RepoTabNav } from '@/components/repo-tab-nav';
import { isDashboardAdmin } from '@/lib/auth/require-session';
import { getDashboardStores } from '@/lib/data/stores';
import { PageError } from '@/components/page-error';

export const dynamic = 'force-dynamic';

export default async function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [admin, repositoryDetail] = await Promise.all([
    isDashboardAdmin(),
    getDashboardStores().repositories.readRepository(id),
  ]);
  if (!repositoryDetail.ok && repositoryDetail.error === 'not-found') return notFound();
  if (!repositoryDetail.ok) {
    console.error('[repo-detail] failed to load repository:', repositoryDetail.message);
    return <PageError />;
  }

  const { credentials: keys, repo } = repositoryDetail.value;
  const hasSourceControl = keys.some(k => k.key_type === 'source-control');
  const hasModelProvider = keys.some(k => k.key_type === 'model-provider');

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-mono">{repo.owner}/{repo.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={repo.enabled ? 'default' : 'secondary'}>
              {repo.enabled ? 'active' : 'disabled'}
            </Badge>
          </div>
        </div>
        {admin && (
          <div className="flex gap-2">
            {repo.enabled ? (
              <form action={disableRepo.bind(null, repo.id)}>
                <Button type="submit" variant="outline" size="sm">Disable</Button>
              </form>
            ) : (
              <form action={enableRepo.bind(null, repo.id)}>
                <Button type="submit" size="sm"
                  disabled={!hasSourceControl || !hasModelProvider}
                  title={(!hasSourceControl || !hasModelProvider) ? 'Add credentials first' : ''}>
                  Enable
                </Button>
              </form>
            )}
            <form action={deleteRepo.bind(null, repo.id)}>
              <Button type="submit" variant="destructive" size="sm"
                disabled={repo.enabled}
                title={repo.enabled ? 'Disable first' : ''}>
                Delete
              </Button>
            </form>
          </div>
        )}
      </div>

      {/* Tab navigation */}
      <RepoTabNav repoId={id} />

      {/* Settings */}
      {admin && (
        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Branch config, budget limit, and concurrency. Applied on next daemon poll.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={updateRepo.bind(null, repo.id)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="staging_branch">Staging Branch</Label>
                  <Input id="staging_branch" name="staging_branch" defaultValue={repo.staging_branch ?? 'staging'} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="production_branch">Production Branch</Label>
                  <Input id="production_branch" name="production_branch" defaultValue={repo.production_branch ?? 'main'} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="budget_limit">Budget Limit ($)</Label>
                  <Input id="budget_limit" name="budget_limit" type="number" step="0.01" min="0" defaultValue={repo.budget_limit ?? ''} placeholder="No limit" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="concurrency_limit">Concurrency Limit</Label>
                  <Input id="concurrency_limit" name="concurrency_limit" type="number" min="1" defaultValue={repo.concurrency_limit ?? ''} placeholder="Default" />
                </div>
              </div>
              <Button type="submit" size="sm">Save Settings</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Credentials */}
      {admin && (
        <Card>
          <CardHeader>
            <CardTitle>Credentials</CardTitle>
            <CardDescription>Write-only. Stored encrypted. Never displayed after saving.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(['source-control', 'model-provider'] as const).map((type) => {
              const key = keys.find(k => k.key_type === type);
              return (
                <form key={type} action={upsertApiKey} className="space-y-2">
                  <input type="hidden" name="repo_id" value={repo.id} />
                  <input type="hidden" name="key_type" value={type} />
                  <Label htmlFor={`key-${type}`}>
                    {type === 'source-control' ? 'GitHub Token' : 'API Key (Anthropic)'}
                    {key && <span className="ml-2 text-xs text-muted-foreground">Last updated: {new Date(key.updated_at).toLocaleDateString()}</span>}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`key-${type}`}
                      name="key_value"
                      type="password"
                      placeholder={key ? '••••••••••••••••••••' : 'Paste token here'}
                      required
                    />
                    <Button type="submit" variant="outline" size="sm">
                      {key ? 'Rotate' : 'Save'}
                    </Button>
                  </div>
                </form>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
