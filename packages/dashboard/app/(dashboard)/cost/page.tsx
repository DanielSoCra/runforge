import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CostChart } from '@/components/cost-chart';

export default async function CostPage() {
  const supabase = await createClient();

  // Last 30 days of cost events
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: events } = await supabase
    .from('cost_events')
    .select('cost, recorded_at, session_type')
    .gte('recorded_at', since.toISOString())
    .order('recorded_at');

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

  // By session type
  const byType: Record<string, number> = {};
  events?.forEach((e) => {
    byType[e.session_type] = (byType[e.session_type] ?? 0) + Number(e.cost);
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Costs</h1>
        <p className="text-muted-foreground text-sm mt-1">Last 30 days — total: ${totalCost.toFixed(4)}</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Daily Cost</CardTitle></CardHeader>
        <CardContent>
          {chartData.length === 0
            ? <p className="text-muted-foreground text-sm py-4">No cost data for the last 30 days.</p>
            : <CostChart data={chartData} />}
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
              <p className="text-muted-foreground text-sm">No cost data for the last 30 days.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
