import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { removeConnection } from '@/actions/github-connections';
import { Plus } from 'lucide-react';

export async function GitHubConnectionsSection() {
  const supabase = await createClient();
  const { data: connections } = await supabase
    .from('github_connections')
    .select('id, display_name, github_login, avatar_url, status, created_at, github_orgs(login)')
    .order('created_at', { ascending: true });

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub Connections</CardTitle>
        <CardDescription>System-level GitHub accounts used for repo polling</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections?.map((conn) => (
          <div key={conn.id} className="flex items-center justify-between border rounded-md p-3">
            <div className="flex items-center gap-3">
              {conn.avatar_url && (
                <img src={conn.avatar_url} alt={conn.github_login} className="w-8 h-8 rounded-full" />
              )}
              <div>
                <p className="font-medium text-sm">{conn.display_name}</p>
                <p className="text-xs text-muted-foreground">
                  {(conn.github_orgs as Array<{ login: string }>)?.map((o) => o.login).join(', ')}
                </p>
              </div>
              {conn.status === 'token_invalid' && (
                <Badge variant="destructive">Token invalid</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/api/auth/github-connection?reauthorize=${conn.id}`}>Re-authorize</Link>
              </Button>
              <form action={removeConnection.bind(null, conn.id)}>
                <Button variant="ghost" size="sm" type="submit">Remove</Button>
              </form>
            </div>
          </div>
        ))}
        {(!connections || connections.length === 0) && (
          <p className="text-sm text-muted-foreground">No GitHub accounts connected.</p>
        )}
        <Button asChild variant="outline" className="w-full">
          <Link href="/api/auth/github-connection">
            <Plus className="h-4 w-4 mr-2" />Add GitHub Account
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
