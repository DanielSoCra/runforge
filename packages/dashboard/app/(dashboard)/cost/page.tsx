import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CostChart } from '@/components/cost-chart';
import { PageError } from '@/components/page-error';
import Link from 'next/link';

const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = typeof RANGE_OPTIONS[number];

function isValidRange(value: string): value is `${RangeDays}` {
  return RANGE_OPTIONS.map(String).includes(value);
}

export default async function CostPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rawRange } = await searchParams;
  const rangeDays = rawRange && isValidRange(rawRange) ? Number(rawRange) as RangeDays : 30;

  const supabase = await createClient();

  const since = new Date();
  since.setDate(since.getDate() - rangeDays);

  const { data: events, error: eventsError } = await supabase
    .from('cost_events')
    .select('cost, recorded_at, session_type, runs(repo_name)')
    .gte('recorded_at', since.toISOString())
    .order('recorded_at');
  if (eventsError) {
    console.error('[cost] failed to load cost events:', eventsError);
    return <PageError />;
  }

  // Aggregate by day
  const byDay: Record<string, number> = {};
  events?.forEach((e) => {
    const day = e.recorded_at.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + Number(e.cost);
  });

  const chartData = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b)) // explicit YYYY-MM-DD lexicographic sort
    .map(([date, cost]) => ({
      date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      cost,
    }));

  const totalCost = events?.reduce((s, e) => s + Number(e.cost), 0) ?? 0;

  // By repository
  const byRepo: Record<string, number> = {};
  events?.forEach((e) => {
    const run = e.runs as { repo_name: string } | null;
    const repoName = run?.repo_name ?? 'unknown';
    byRepo[repoName] = (byRepo[repoName] ?? 0) + Number(e.cost);
  });

  // By session type
  const byType: Record<string, number> = {};
  events?.forEach((e) => {
    byType[e.session_type] = (byType[e.session_type] ?? 0) + Number(e.cost);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="text-muted-foreground text-sm mt-1">Last {rangeDays} days — total: ${totalCost.toFixed(4)}</p>
        </div>
        <div className="flex gap-1" data-testid="range-selector">
          {RANGE_OPTIONS.map((days) => (
            <Link
              key={days}
              href={`/cost?range=${days}`}
              aria-current={days === rangeDays ? 'page' : undefined}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                days === rangeDays
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {days}d
            </Link>
          ))}
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle>Daily Cost</CardTitle></CardHeader>
        <CardContent>
          {chartData.length === 0
            ? <p className="text-muted-foreground text-sm py-4">No cost data for the last {rangeDays} days.</p>
            : <CostChart data={chartData} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>By Repository</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2" data-testid="by-repo">
            {Object.entries(byRepo)
              .sort(([, a], [, b]) => b - a)
              .map(([repo, cost]) => (
              <div key={repo} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground font-mono">{repo}</span>
                <span className="font-mono">${cost.toFixed(4)}</span>
              </div>
            ))}
            {Object.keys(byRepo).length === 0 && (
              <p className="text-muted-foreground text-sm">No cost data for the last {rangeDays} days.</p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>By Session Type</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {Object.entries(byType).map(([type, cost]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground capitalize">{type}</span>
                <span className="font-mono">${cost.toFixed(4)}</span>
              </div>
            ))}
            {Object.keys(byType).length === 0 && (
              <p className="text-muted-foreground text-sm">No cost data for the last {rangeDays} days.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
