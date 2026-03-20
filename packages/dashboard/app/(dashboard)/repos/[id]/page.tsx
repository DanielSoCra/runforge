import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { upsertApiKey } from '@/actions/api-keys';
import { enableRepo, disableRepo, deleteRepo } from '@/actions/repos';
import { RepoTabNav } from '@/components/repo-tab-nav';

export default async function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: repo } = await supabase.from('repos').select('*').eq('id', id).single();
  if (!repo || repo.deleted_at) notFound();

  const { data: keys } = await supabase.from('api_keys')
    .select('key_type, updated_at')
    .eq('repo_id', id);

  const hasSourceControl = keys?.some(k => k.key_type === 'source-control');
  const hasModelProvider = keys?.some(k => k.key_type === 'model-provider');

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
      </div>

      {/* Tab navigation */}
      <RepoTabNav repoId={id} />

      {/* Credentials */}
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>Write-only. Stored encrypted. Never displayed after saving.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(['source-control', 'model-provider'] as const).map((type) => {
            const key = keys?.find(k => k.key_type === type);
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
    </div>
  );
}
