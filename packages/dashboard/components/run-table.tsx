import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Database } from '@/lib/types';

type Run = Database['public']['Tables']['runs']['Row'];

const outcomeVariant = {
  'in-progress': 'secondary',
  complete: 'default',
  stuck: 'destructive',
  escalated: 'destructive',
} as const;

export function RunTable({ runs }: { runs: Run[] }) {
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
            <TableHead>Started</TableHead>
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
                ${Number(run.total_cost).toFixed(4)}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {new Date(run.started_at).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
