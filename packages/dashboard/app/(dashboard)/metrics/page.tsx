import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EscalationTrendChart } from '@/components/metrics/escalation-trend-chart';
import { daemonFetch } from '@/lib/daemon-fetch';

export const dynamic = 'force-dynamic';

interface EscalationResponse {
  weeks: Array<{
    weekStart: string;
    deploymentId: string;
    raised: number;
    answered: number;
    autoMerges: number;
    operatorTouchesPerDelivered: number | null;
  }>;
  deployments?: string[];
  unavailable?: boolean;
}

async function readEscalationMetrics(): Promise<EscalationResponse> {
  try {
    const res = await daemonFetch('/metrics/escalation', { cache: 'no-store' });
    const json = (await res.json().catch(() => ({ weeks: [] }))) as EscalationResponse;
    return {
      weeks: Array.isArray(json.weeks) ? json.weeks : [],
      deployments: Array.isArray(json.deployments) ? json.deployments : undefined,
      unavailable: json.unavailable === true,
    };
  } catch (e) {
    console.error('[metrics] failed to load escalation metrics:', e);
    return { weeks: [], unavailable: true };
  }
}

export default async function MetricsPage() {
  const { weeks, deployments, unavailable } = await readEscalationMetrics();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Metrics</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Escalation-rate trend per deployment.
        </p>
      </div>

      {unavailable && (
        <p className="text-amber-600 text-sm">Escalation metrics temporarily unavailable.</p>
      )}

      <Card>
        <CardHeader><CardTitle>Escalation Trend</CardTitle></CardHeader>
        <CardContent>
          <EscalationTrendChart data={weeks} />
        </CardContent>
      </Card>

      {deployments !== undefined && deployments.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Deployments</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {deployments.map((deployment) => (
                <span
                  key={deployment}
                  className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-mono"
                >
                  {deployment}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
