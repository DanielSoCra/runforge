import { createClient } from '@/lib/supabase/server';
import { RunTable } from '@/components/run-table';
import { PageError } from '@/components/page-error';

const VALID_OUTCOMES = ['in-progress', 'complete', 'stuck', 'escalated'] as const;
type RunOutcome = typeof VALID_OUTCOMES[number];

function isValidOutcome(value: string): value is RunOutcome {
  return (VALID_OUTCOMES as readonly string[]).includes(value);
}

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
  if (outcome && isValidOutcome(outcome)) query = query.eq('outcome', outcome);

  const [{ data: runs, error: runsError }, { data: repos }] = await Promise.all([
    query,
    supabase.from('repos').select('id, budget_limit').is('deleted_at', null),
  ]);
  if (runsError) {
    console.error('[runs] failed to load runs:', runsError);
    return <PageError />;
  }

  const budgetByRepoId: Record<string, number | null> = {};
  for (const r of repos ?? []) budgetByRepoId[r.id] = r.budget_limit;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="text-muted-foreground text-sm mt-1">Pipeline execution history</p>
      </div>
      <RunTable runs={runs ?? []} budgetByRepoId={budgetByRepoId} />
    </div>
  );
}
