'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, DollarSign, Database, Pause, Play, Server } from 'lucide-react';

type DaemonStatus = 'running' | 'paused' | 'offline';

interface StatsCardsProps {
  activeRuns: number;
  todayCost: number;
  totalRepos: number;
  daemonStatus: DaemonStatus;
}

export function StatsCards({ activeRuns, todayCost, totalRepos, daemonStatus }: StatsCardsProps) {
  const statusColor = { running: 'default', paused: 'secondary', offline: 'destructive' } as const;
  const [status, setStatus] = useState<DaemonStatus>(daemonStatus);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = status === 'running' ? 'pause' : status === 'paused' ? 'resume' : null;
  const actionLabel = action === 'pause' ? 'Pause' : 'Resume';
  const ActionIcon = action === 'pause' ? Pause : Play;

  async function updateDaemon() {
    if (!action) return;

    setIsUpdating(true);
    setError(null);
    try {
      const res = await fetch(`/api/daemon/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error('Daemon unreachable');
      const body = await res.json().catch(() => null) as { paused?: boolean } | null;
      if (typeof body?.paused === 'boolean') {
        setStatus(body.paused ? 'paused' : 'running');
      } else {
        setStatus(action === 'pause' ? 'paused' : 'running');
      }
    } catch {
      setError('Daemon unreachable');
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Active Runs</CardTitle>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{activeRuns}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Today's Cost (UTC)</CardTitle>
          <DollarSign className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">${todayCost.toFixed(2)}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Repositories</CardTitle>
          <Database className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalRepos}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Daemon</CardTitle>
          <Server className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="flex min-h-8 items-center justify-between gap-2">
            <Badge variant={statusColor[status]}>{status}</Badge>
            {action && (
              <Button
                type="button"
                variant={action === 'pause' ? 'outline' : 'default'}
                size="sm"
                onClick={updateDaemon}
                disabled={isUpdating}
                aria-label={`${actionLabel} daemon`}
              >
                <ActionIcon data-icon="inline-start" />
                {isUpdating ? 'Working' : actionLabel}
              </Button>
            )}
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
