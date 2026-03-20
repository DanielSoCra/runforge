// packages/dashboard/components/issues-board.tsx
'use client';
import { useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { BoardCard, BoardColumn } from '@/lib/classify-issues';

const COLUMNS: { id: BoardColumn; label: string; countColor: string }[] = [
  { id: 'not-ready', label: 'Not Ready', countColor: 'text-muted-foreground' },
  { id: 'ready',     label: 'Ready',     countColor: 'text-green-500' },
  { id: 'running',   label: 'Running',   countColor: 'text-blue-400' },
  { id: 'complete',  label: 'Complete',  countColor: 'text-muted-foreground' },
  { id: 'stuck',     label: 'Stuck',     countColor: 'text-destructive' },
];

const COLUMN_BORDER: Record<BoardColumn, string> = {
  'not-ready': 'border-l-muted-foreground',
  'ready':     'border-l-green-500',
  'running':   'border-l-blue-400',
  'complete':  'border-l-purple-500',
  'stuck':     'border-l-destructive',
};

function IssueCard({ card }: { card: BoardCard }) {
  return (
    <div className={`bg-background rounded-md p-3 border-l-2 ${COLUMN_BORDER[card.column]} space-y-2${card.column === 'complete' ? ' opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted-foreground font-mono">
          #{card.issueNumber} · {card.repoOwner}/{card.repoName}
        </span>
        <a
          href={card.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline shrink-0"
          aria-label={`Open issue #${card.issueNumber} on GitHub`}
        >
          ↗
        </a>
      </div>
      <p className="text-xs font-medium leading-snug">{card.issueTitle}</p>
      {card.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0">{l}</Badge>
          ))}
        </div>
      )}
      {card.column === 'not-ready' && (
        <div className="border-t border-border pt-2 text-[10px] text-muted-foreground">
          Missing: <Badge variant="secondary" className="text-[10px] px-1.5 py-0">ready</Badge>
          <span className="ml-1">— add in GitHub to queue</span>
        </div>
      )}
      {card.column === 'ready' && (
        <p className="text-[10px] text-green-500">Queued for pickup</p>
      )}
      {card.column === 'running' && card.currentPhase && (
        <div className="flex items-center gap-1.5 text-[10px] text-blue-400">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 inline-block" />
          {card.currentPhase}
        </div>
      )}
      {card.column === 'stuck' && (
        <p className="text-[10px] text-destructive">✗ stuck — needs attention</p>
      )}
    </div>
  );
}

interface IssuesBoardProps {
  cards: BoardCard[];
}

export function IssuesBoard({ cards }: IssuesBoardProps) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const scanNow = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch('/api/daemon/issues/scan', { method: 'POST' });
      const data = await res.json() as { scanned?: number; error?: string };
      if (res.ok) {
        setScanResult(`Scanned ${data.scanned ?? 0} repos`);
        setTimeout(() => setScanResult(null), 3000);
      } else {
        setScanResult(data.error ?? 'Error');
        setTimeout(() => setScanResult(null), 3000);
      }
    } catch {
      setScanResult('Daemon unreachable');
      setTimeout(() => setScanResult(null), 3000);
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* Scan Now header action */}
      <div className="flex items-center justify-end gap-3">
        {scanResult && <span className="text-xs text-muted-foreground">{scanResult}</span>}
        <Button variant="outline" size="sm" onClick={scanNow} disabled={scanning}>
          {scanning ? 'Scanning…' : '⟳ Scan Now'}
        </Button>
      </div>

      {/* 5-column kanban */}
      <div className="grid grid-cols-5 gap-3 min-h-[400px]">
        {COLUMNS.map(({ id, label, countColor }) => {
          const colCards = cards.filter((c) => c.column === id);
          return (
            <div key={id} className="bg-muted/30 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </span>
                <span className={`text-[10px] font-semibold ${countColor}`}>
                  {colCards.length}
                </span>
              </div>
              {colCards.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic pt-2">None</p>
              ) : (
                colCards.map((card) => (
                  <IssueCard key={`${card.repoOwner}/${card.repoName}#${card.issueNumber}`} card={card} />
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
