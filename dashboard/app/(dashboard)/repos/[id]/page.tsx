import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';

export default async function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: repo } = await supabase.from('repos').select('*').eq('id', id).single();
  if (!repo || repo.deleted_at) notFound();
  return (
    <div>
      <h1 className="text-2xl font-semibold font-mono">{repo.owner}/{repo.name}</h1>
      <p className="text-muted-foreground text-sm mt-1">Credentials and settings — coming in Task 8</p>
    </div>
  );
}
