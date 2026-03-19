import { createClient } from '@/lib/supabase/server';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { Plus } from 'lucide-react';

export default async function ReposPage() {
  const supabase = await createClient();
  const { data: repos } = await supabase
    .from('repos')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Repositories</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage monitored repositories</p>
        </div>
        <Button asChild>
          <Link href="/repos/new"><Plus className="h-4 w-4 mr-2" />Add Repository</Link>
        </Button>
      </div>
      <div className="space-y-3">
        {repos?.map((repo) => (
          <Card key={repo.id} className="hover:border-border/80 transition-colors">
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <span className="font-mono font-medium">{repo.owner}/{repo.name}</span>
                <Badge variant={repo.enabled ? 'default' : 'secondary'}>
                  {repo.enabled ? 'active' : 'disabled'}
                </Badge>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/repos/${repo.id}`}>Configure →</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
        {(!repos || repos.length === 0) && (
          <div className="text-center py-12 text-muted-foreground">
            No repositories yet. <Link href="/repos/new" className="underline">Add one</Link>.
          </div>
        )}
      </div>
    </div>
  );
}
