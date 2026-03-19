import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface PhaseEvent {
  name: string;
  started_at?: string;
  duration_ms?: number;
  cost?: number;
}

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: run } = await supabase.from('runs').select('*').eq('id', id).single();
  if (!run) notFound();

  const phases = Array.isArray(run.phases) ? (run.phases as unknown as PhaseEvent[]) : [];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-semibold">{run.repo_owner}/{run.repo_name} #{run.issue_number}</h1>
          <Badge>{run.outcome}</Badge>
        </div>
        <p className="text-muted-foreground">{run.issue_title}</p>
      </div>

      {/* Phase timeline */}
      <Card>
        <CardHeader><CardTitle>Phases</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {phases.length === 0 && <p className="text-muted-foreground text-sm">No phase data.</p>}
            {phases.map((phase, i: number) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div className="font-medium text-sm">{phase.name}</div>
                <div className="flex gap-6 text-sm text-muted-foreground">
                  <span>{phase.duration_ms ? `${(phase.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
                  <span className="font-mono">${Number(phase.cost ?? 0).toFixed(4)}</span>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between pt-2 font-semibold text-sm">
              <span>Total</span>
              <span className="font-mono">${Number(run.total_cost).toFixed(4)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Final report */}
      {run.report && (
        <Card>
          <CardHeader><CardTitle>Report</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-sm whitespace-pre-wrap font-mono text-muted-foreground">{run.report}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
