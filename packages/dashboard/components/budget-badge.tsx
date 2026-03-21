import { Badge } from '@/components/ui/badge';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

const WARNING_THRESHOLD = 0.8;

export function getBudgetStatus(totalCost: number, budgetLimit: number | null): BudgetStatus {
  if (budgetLimit == null || budgetLimit <= 0) return 'ok';
  const ratio = totalCost / budgetLimit;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= WARNING_THRESHOLD) return 'warning';
  return 'ok';
}

export function BudgetBadge({
  totalCost,
  budgetLimit,
}: {
  totalCost: number;
  budgetLimit: number | null;
}) {
  const status = getBudgetStatus(totalCost, budgetLimit);
  if (status === 'ok') return null;

  if (status === 'exceeded') {
    return (
      <Badge variant="destructive" className="ml-2 text-[10px]">
        Over budget
      </Badge>
    );
  }

  return (
    <Badge className="ml-2 text-[10px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
      80%+ budget
    </Badge>
  );
}
