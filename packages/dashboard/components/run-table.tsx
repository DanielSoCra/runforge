import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { BudgetBadge } from '@/components/budget-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Database } from '@/lib/types';

type Run = Database['public']['Tables']['runs']['Row'];

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

const outcomeVariant = {
  'in-progress': 'secondary',
  complete: 'default',
  stuck: 'destructive',
  escalated: 'destructive',
  failed: 'destructive',
} as const;

export function RunTable({ runs, budgetByRepoId }: { runs: Run[]; budgetByRepoId?: Record<string, number | null> }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-border p-8 text-center text-muted-foreground text-sm">
        No runs found.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead>Issue</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="cursor-pointer hover:bg-accent/30">
              <TableCell className="font-mono text-sm">
                {run.repo_owner}/{run.repo_name}
              </TableCell>
              <TableCell>
                <Link href={`/runs/${run.id}`} className="hover:underline">
                  <span className="text-muted-foreground">#{run.issue_number}</span>{' '}
                  {run.issue_title}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{run.current_phase ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={outcomeVariant[run.outcome]}>{run.outcome}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                <span className="inline-flex items-center">
                  ${Number(run.total_cost).toFixed(4)}
                  <BudgetBadge
                    totalCost={Number(run.total_cost)}
                    budgetLimit={run.repo_id ? budgetByRepoId?.[run.repo_id] ?? null : null}
                  />
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm" title={new Date(run.started_at).toLocaleString()}>
                {run.outcome === 'complete'
                  ? new Date(run.started_at).toLocaleString()
                  : formatElapsed(run.started_at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
