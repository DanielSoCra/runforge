import { createClient } from '@/lib/supabase/server';
import { StatsCards } from '@/components/stats-cards';
import { RunTable } from '@/components/run-table';

export default async function HomePage() {
  const supabase = await createClient();

  const [{ data: repos }, { data: runs }, { data: costs }] = await Promise.all([
    supabase.from('repos').select('id').is('deleted_at', null).eq('enabled', true),
    supabase.from('runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    supabase.from('cost_events')
      .select('cost')
      .gte('recorded_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
  ]);

  const activeRuns = runs?.filter(r => r.outcome === 'in-progress').length ?? 0;
  const todayCost = costs?.reduce((sum, e) => sum + Number(e.cost), 0) ?? 0;

  let daemonStatus: 'running' | 'paused' | 'offline' = 'offline';
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/status`, { next: { revalidate: 10 }, signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json();
      daemonStatus = json.state ?? 'running';
    }
  } catch {}

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Overview of all pipeline activity</p>
      </div>
      <StatsCards
        activeRuns={activeRuns}
        todayCost={todayCost}
        totalRepos={repos?.length ?? 0}
        daemonStatus={daemonStatus}
      />
      <div>
        <h2 className="text-lg font-medium mb-4">Recent Runs</h2>
        <RunTable runs={runs ?? []} />
      </div>
    </div>
  );
}
