import { PageError } from '@/components/page-error';
import { StatsCards } from '@/components/stats-cards';
import { RunTable } from '@/components/run-table';
import {
  DecisionInbox,
  type RankedListItem,
} from '@/components/decisions/decision-inbox';
import { daemonFetch } from '@/lib/daemon-fetch';
import { getDashboardStores } from '@/lib/data/stores';

export const dynamic = 'force-dynamic';

/**
 * Read the ranked pending-decisions inbox from the daemon Decision API
 * (STACK-AC-OPERATOR-SURFACE-API). FAIL-SAFE: any daemon 503 / unreachable /
 * DaemonConfigError / non-JSON body degrades to `{ items: [], unavailable: true }`
 * so the default surface renders a calm degraded panel, never crashes
 * (STACK-AC-OPERATOR-SURFACE-CLIENT). The browser-facing equivalent is the proxy
 * route `app/api/decisions/pending/route.ts`.
 */
async function readDecisionInbox(): Promise<{
  items: RankedListItem[];
  unavailable: boolean;
}> {
  try {
    const res = await daemonFetch('/decisions/pending', { cache: 'no-store' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null) return { items: [], unavailable: true };
    const items: RankedListItem[] = Array.isArray(json)
      ? (json as RankedListItem[])
      : ((json.items ?? []) as RankedListItem[]);
    return { items, unavailable: false };
  } catch (err) {
    console.error(
      '[decisions-inbox] unreachable:',
      err instanceof Error ? err.message : err,
    );
    return { items: [], unavailable: true };
  }
}

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

  const inbox = await readDecisionInbox();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Overview of all pipeline activity</p>
      </div>
      {/* Decisions inbox — the default surface's primary element alongside the
          briefing (FUNC-AC-OPERATOR-SURFACE: "decisions and the briefing"). */}
      <div>
        <h2 className="text-lg font-medium mb-4">Decisions</h2>
        <DecisionInbox items={inbox.items} unavailable={inbox.unavailable} />
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
