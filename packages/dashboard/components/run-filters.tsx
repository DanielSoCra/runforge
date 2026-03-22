'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Repo {
  id: string;
  name: string;
  owner: string;
}

export function RunFilters({ repos }: { repos: Repo[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentRepo = searchParams.get('repo') ?? '';
  const currentOutcome = searchParams.get('outcome') ?? '';

  function navigate(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    router.push(`/runs?${params.toString()}`);
  }

  return (
    <div className="flex gap-2" data-testid="run-filters">
      <Select value={currentRepo || 'all'} onValueChange={(v) => navigate('repo', v)}>
        <SelectTrigger size="sm" aria-label="Filter by repository">
          <SelectValue placeholder="All repos" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All repos</SelectItem>
          {repos.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.owner}/{r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentOutcome || 'all'} onValueChange={(v) => navigate('outcome', v)}>
        <SelectTrigger size="sm" aria-label="Filter by outcome">
          <SelectValue placeholder="All outcomes" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All outcomes</SelectItem>
          <SelectItem value="in-progress">In progress</SelectItem>
          <SelectItem value="complete">Complete</SelectItem>
          <SelectItem value="stuck">Stuck</SelectItem>
          <SelectItem value="escalated">Escalated</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
