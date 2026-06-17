import { PageError } from '@/components/page-error';
import { StatsCards } from '@/components/stats-cards';
import { RunTable } from '@/components/run-table';
import { getDashboardStores } from '@/lib/data/stores';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // UTC midnight for "today" — consistent regardless of server timezone
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);

  const overview = await getDashboardStores().overview.readOverview(todayUTC);
  if (!overview.ok) {
    console.error('[dashboard] failed to load overview:', overview.message);
    return <PageError />;
  }

  let daemonStatus: 'running' | 'paused' | 'offline' = 'offline';
  if (!process.env.DAEMON_URL) {
    console.error('[daemon-status] DAEMON_URL is not configured');
  } else {
    try {
      const res = await fetch(`${process.env.DAEMON_URL}/status`, {
        cache: 'no-store',
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
        activeRuns={overview.value.activeRuns}
        todayCost={overview.value.todayCost}
        totalRepos={overview.value.totalRepos}
        daemonStatus={daemonStatus}
      />
      <div>
        <h2 className="text-lg font-medium mb-4">Recent Runs</h2>
        <RunTable
          runs={overview.value.recentRuns}
          budgetByRepoId={overview.value.budgetByRepoId}
        />
      </div>
    </div>
  );
}
