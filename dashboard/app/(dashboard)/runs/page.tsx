import { createClient } from '@/lib/supabase/server';
import { RunTable } from '@/components/run-table';
import { RealtimeProvider } from '@/components/realtime-provider';

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; outcome?: string }>;
}) {
  const { repo, outcome } = await searchParams;
  const supabase = await createClient();
  let query = supabase
    .from('runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(100);

  if (repo) query = query.eq('repo_id', repo);
  if (outcome) query = query.eq('outcome', outcome);

  const { data: runs } = await query;

  return (
    <div className="space-y-6">
      <RealtimeProvider />
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="text-muted-foreground text-sm mt-1">Pipeline execution history</p>
      </div>
      <RunTable runs={runs ?? []} />
    </div>
  );
}
