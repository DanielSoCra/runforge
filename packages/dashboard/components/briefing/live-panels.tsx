'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Play,
  AlertCircle,
  Clock,
  ExternalLink,
  Loader2,
} from 'lucide-react';

export interface ActiveRun {
  id: string;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  issue_title: string;
  current_phase: string | null;
  outcome: string;
  total_cost: number;
  started_at: string;
}

export interface AttentionItem {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  reason: 'blocked' | 'review' | 'failure';
  waitDuration: string;
  actionLinks: { label: string; url: string }[];
}

export interface UpNextItem {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  pipelineLabel: string;
}

interface LivePanelsProps {
  activeRuns: ActiveRun[];
  needsAttention: AttentionItem[];
  upNext: UpNextItem[];
  refreshAction: () => Promise<{
    activeRuns: ActiveRun[];
    needsAttention: AttentionItem[];
    upNext: UpNextItem[];
  }>;
}

const urgencyConfig = {
  blocked: { label: 'Blocked', variant: 'destructive' as const, className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  review: { label: 'Review', variant: 'default' as const, className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  failure: { label: 'Failure', variant: 'secondary' as const, className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
};

const urgencyOrder: Record<string, number> = { blocked: 0, review: 1, failure: 2 };

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hrs > 0) return `${hrs}h ${remainMins}m`;
  return `${mins}m`;
}

export function LivePanels({
  activeRuns: initialActiveRuns,
  needsAttention: initialNeedsAttention,
  upNext: initialUpNext,
  refreshAction,
}: LivePanelsProps) {
  const [activeRuns, setActiveRuns] = useState(initialActiveRuns);
  const [needsAttention, setNeedsAttention] = useState(initialNeedsAttention);
  const [upNext, setUpNext] = useState(initialUpNext);

  useEffect(() => {
    const intervalMs = parseInt(
      process.env.NEXT_PUBLIC_REFRESH_INTERVAL_MS ?? '30000',
      10,
    );

    const id = setInterval(async () => {
      try {
        const data = await refreshAction();
        setActiveRuns(data.activeRuns);
        setNeedsAttention(data.needsAttention);
        setUpNext(data.upNext);
      } catch {
        // Silently skip failed refresh — stale data is acceptable per L3 spec
      }
    }, intervalMs);

    return () => clearInterval(id);
  }, [refreshAction]);

  const sortedAttention = [...needsAttention].sort(
    (a, b) => (urgencyOrder[a.reason] ?? 3) - (urgencyOrder[b.reason] ?? 3),
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Active Now */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Play className="h-4 w-4 text-green-500" />
            Active Now
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active runs</p>
          ) : (
            <ul className="space-y-3">
              {activeRuns.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-col gap-1 rounded-md border p-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {run.repo_owner}/{run.repo_name} #{run.issue_number}
                    </span>
                    <Badge variant="outline">{run.current_phase ?? 'pending'}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>${run.total_cost.toFixed(4)}</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {elapsed(run.started_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Needs Attention */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="h-4 w-4 text-yellow-500" />
            Needs Attention
          </CardTitle>
        </CardHeader>
        <CardContent>
          {sortedAttention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs attention</p>
          ) : (
            <ul className="space-y-3">
              {sortedAttention.map((item, i) => {
                const config = urgencyConfig[item.reason] ?? urgencyConfig.failure;
                return (
                  <li
                    key={`${item.repoOwner}-${item.issueNumber}-${i}`}
                    className="flex flex-col gap-1 rounded-md border p-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={config.variant} className={config.className}>
                        {config.label}
                      </Badge>
                      <span className="font-medium">
                        {item.repoOwner}/{item.repoName} #{item.issueNumber}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{item.reason}</span>
                      <span>waiting {item.waitDuration}</span>
                    </div>
                    {item.actionLinks.map((link) => (
                      <a
                        key={link.url}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400 mt-1"
                      >
                        {link.label}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Up Next */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Loader2 className="h-4 w-4 text-blue-500" />
            Up Next
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upNext.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items queued</p>
          ) : (
            <ul className="space-y-3">
              {upNext.map((item, i) => (
                <li
                  key={`${item.repoOwner}-${item.issueNumber}-${i}`}
                  className="flex items-center gap-2 rounded-md border p-3 text-sm"
                >
                  <span className="font-medium">
                    {item.repoOwner}/{item.repoName} #{item.issueNumber}
                  </span>
                  <Badge variant="outline">{item.pipelineLabel}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
