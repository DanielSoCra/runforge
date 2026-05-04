import { createClient } from '@/lib/supabase/server';
import { requireAdmin } from '@/lib/auth';
import { ReleaseApprovalPanel } from '@/components/release-approval-panel';
import { PageError } from '@/components/page-error';

export const dynamic = 'force-dynamic';

interface CompletedRun {
  issue_number: number;
  repo_owner: string;
  repo_name: string;
  issue_title: string;
  pipeline_variant: string;
  total_cost: number;
  completed_at: string | null;
  report: string | null;
}

function formatCost(value: number) {
  return `$${value.toFixed(2)}`;
}

function formatCompletedAt(value: string | null) {
  if (!value) return 'Completion time unavailable';
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export default async function ReleasesPage() {
  const supabase = await createClient();
  await requireAdmin(supabase);

  const { data, error } = await supabase
    .from('runs')
    .select('issue_number, repo_owner, repo_name, issue_title, pipeline_variant, total_cost, completed_at, report')
    .eq('outcome', 'complete')
    .order('completed_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[releases] failed to load completed runs:', error);
    return <PageError />;
  }

  const runs = (data ?? []) as CompletedRun[];
  const totalCost = runs.reduce((sum, run) => sum + Number(run.total_cost ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Releases</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Completed work accumulated in pre-production for operator approval
          </p>
        </div>
        <ReleaseApprovalPanel issueCount={runs.length} />
      </div>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Ready items</p>
          <p className="mt-1 text-2xl font-semibold">{runs.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Total cost</p>
          <p className="mt-1 text-2xl font-semibold">{formatCost(totalCost)}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Approval mode</p>
          <p className="mt-1 text-sm font-medium">Production PR</p>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Release Notes</h2>
          <p className="text-sm text-muted-foreground">Issues completed: {runs.length}</p>
          <p className="text-sm text-muted-foreground">Total cost: {formatCost(totalCost)}</p>
        </div>

        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center">
            <p className="text-sm text-muted-foreground">No completed work is ready for production.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => (
              <article
                key={`${run.repo_owner}/${run.repo_name}#${run.issue_number}`}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>#{run.issue_number}</span>
                      <span>{run.repo_owner}/{run.repo_name}</span>
                      <span>{run.pipeline_variant} pipeline</span>
                    </div>
                    <h3 className="mt-1 text-sm font-medium">{run.issue_title}</h3>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>{formatCost(Number(run.total_cost ?? 0))}</p>
                    <p>{formatCompletedAt(run.completed_at)}</p>
                  </div>
                </div>
                {run.report && (
                  <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{run.report}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
