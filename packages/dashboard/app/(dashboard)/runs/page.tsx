import { createClient } from '@/lib/supabase/server';
import { RunTable } from '@/components/run-table';
import { PageError } from '@/components/page-error';
import Link from 'next/link';

const VALID_OUTCOMES = ['in-progress', 'complete', 'stuck', 'escalated'] as const;
type RunOutcome = typeof VALID_OUTCOMES[number];

const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = typeof RANGE_OPTIONS[number];

function isValidOutcome(value: string): value is RunOutcome {
  return (VALID_OUTCOMES as readonly string[]).includes(value);
}

function isValidRange(value: string): value is `${RangeDays}` {
  return RANGE_OPTIONS.map(String).includes(value);
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; outcome?: string; range?: string }>;
}) {
  const { repo, outcome, range: rawRange } = await searchParams;
  const rangeDays = rawRange && isValidRange(rawRange) ? Number(rawRange) as RangeDays : 30;

  const supabase = await createClient();

  const since = new Date();
  since.setDate(since.getDate() - rangeDays);

  let query = supabase
    .from('runs')
    .select('*')
    .gte('started_at', since.toISOString())
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

  // Build base URL for range links, preserving existing filters
  const filterParams = new URLSearchParams();
  if (repo) filterParams.set('repo', repo);
  if (outcome) filterParams.set('outcome', outcome);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Runs</h1>
          <p className="text-muted-foreground text-sm mt-1">Last {rangeDays} days — pipeline execution history</p>
        </div>
        <div className="flex gap-1" data-testid="range-selector">
          {RANGE_OPTIONS.map((days) => {
            const params = new URLSearchParams(filterParams);
            params.set('range', String(days));
            return (
              <Link
                key={days}
                href={`/runs?${params.toString()}`}
                aria-current={days === rangeDays ? 'page' : undefined}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  days === rangeDays
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {days}d
              </Link>
            );
          })}
        </div>
      </div>
      <RunTable runs={runs ?? []} budgetByRepoId={budgetByRepoId} />
    </div>
  );
}
