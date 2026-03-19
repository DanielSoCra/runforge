import type { Database } from '@/lib/types';

type Run = Database['public']['Tables']['runs']['Row'];

interface RunTableProps {
  runs: Run[];
}

export function RunTable({ runs }: RunTableProps) {
  return (
    <div className="text-muted-foreground text-sm">
      {runs.length === 0 ? 'No runs yet.' : `${runs.length} run(s)`}
    </div>
  );
}
