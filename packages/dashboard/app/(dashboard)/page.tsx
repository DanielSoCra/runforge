import { createClient } from '@/lib/supabase/server';
import { StatsCards } from '@/components/stats-cards';
import { RunTable } from '@/components/run-table';

export default async function HomePage() {
  const supabase = await createClient();

  // UTC midnight for "today" — consistent regardless of server timezone
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);

  const [{ data: repos }, { data: runs }, { data: costs }, { count: activeRunsCount }] = await Promise.all([
    supabase.from('repos').select('id').is('deleted_at', null).eq('enabled', true),
    supabase.from('runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    supabase.from('cost_events')
      .select('cost')
      .gte('recorded_at', todayUTC.toISOString()),
    // Dedicated count query — not limited to 10 rows like the recent-runs list
    supabase.from('runs')
      .select('id', { count: 'exact', head: true })
      .eq('outcome', 'in-progress'),
  ]);

  const activeRuns = activeRunsCount ?? 0;
  const todayCost = costs?.reduce((sum, e) => sum + Number(e.cost), 0) ?? 0;

  let daemonStatus: 'running' | 'paused' | 'offline' = 'offline';
  if (!process.env.DAEMON_URL) {
    console.error('[daemon-status] DAEMON_URL is not configured');
  } else {
    try {
      const res = await fetch(`${process.env.DAEMON_URL}/status`, {
        next: { revalidate: 10 },
        signal: AbortSignal.timeout(3000),
      });
      const json = await res.json().catch(() => null);
      daemonStatus = json?.state ?? (res.ok ? 'running' : 'offline');
    } catch (err) {
      console.error('[daemon-status] unreachable:', err instanceof Error ? err.message : err);
    }
  }

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
