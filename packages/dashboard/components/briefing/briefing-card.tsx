'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Bot, AlertTriangle, TrendingUp, ExternalLink } from 'lucide-react';

interface BriefingLink {
  label: string;
  url: string;
}

interface BriefingChange {
  summary: string;
  links: BriefingLink[];
}

interface AttentionItem {
  issueNumber: number;
  reason: string;
  waitDuration: string;
  actionLinks: BriefingLink[];
}

export interface Briefing {
  status_line: string;
  changes: BriefingChange[];
  attention: AttentionItem[];
  forecast: string;
  generated_at: string;
}

interface BriefingCardProps {
  briefing: Briefing | null;
  intervalMs?: number;
}

function isStale(generatedAt: string, intervalMs: number): boolean {
  const age = Date.now() - new Date(generatedAt).getTime();
  return age > 2 * intervalMs;
}

function reasonBadgeVariant(reason: string): 'destructive' | 'default' | 'secondary' {
  switch (reason) {
    case 'blocked':
      return 'destructive';
    case 'review':
      return 'default';
    case 'failure':
      return 'secondary';
    default:
      return 'secondary';
  }
}

export function BriefingCard({ briefing, intervalMs = 300_000 }: BriefingCardProps) {
  if (!briefing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-muted-foreground" />
            AI Briefing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No briefing generated yet</p>
        </CardContent>
      </Card>
    );
  }

  const stale = isStale(briefing.generated_at, intervalMs);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-muted-foreground" />
          AI Briefing
          {stale && (
            <Badge variant="secondary" className="ml-2 gap-1 text-yellow-600 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/30">
              <AlertTriangle className="h-3 w-3" />
              Stale
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Status line */}
        <p className="text-sm font-semibold">{briefing.status_line}</p>

        {/* Changes */}
        {briefing.changes.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent Changes
            </h3>
            <ul className="space-y-2">
              {briefing.changes.map((change, i) => (
                <li key={i} className="text-sm">
                  <span>{change.summary}</span>
                  {change.links.length > 0 && (
                    <span className="ml-2 inline-flex gap-2">
                      {change.links.map((link, j) => (
                        <a
                          key={j}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {link.label}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Attention items */}
        {briefing.attention.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Needs Attention
            </h3>
            <ul className="space-y-3">
              {briefing.attention.map((item, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 text-sm rounded-md border p-3"
                >
                  <Badge variant={reasonBadgeVariant(item.reason)}>
                    {item.reason}
                  </Badge>
                  <span className="font-medium">#{item.issueNumber}</span>
                  <span className="text-muted-foreground">
                    waiting {item.waitDuration}
                  </span>
                  {item.actionLinks.map((link, j) => (
                    <a
                      key={j}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {link.label}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Forecast */}
        {briefing.forecast && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Forecast
            </h3>
            <p className="text-sm text-muted-foreground">{briefing.forecast}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
