'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Activity, ExternalLink } from 'lucide-react';

interface EventLink {
  label: string;
  url: string;
}

interface ActivityEvent {
  id: string;
  occurred_at: string;
  event_type: string;
  severity: 'info' | 'warning' | 'error';
  summary: string;
  links: EventLink[];
}

interface ActivityFeedProps {
  initialEvents: ActivityEvent[];
}

const severityDotColor: Record<string, string> = {
  info: 'bg-blue-500',
  warning: 'bg-yellow-500',
  error: 'bg-red-500',
};

const eventTypeBadgeColor: Record<string, string> = {
  run_started: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  run_completed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  run_stuck: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  phase_changed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  merge_detected: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ActivityFeed({ initialEvents }: ActivityFeedProps) {
  if (initialEvents.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            Activity Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No activity recorded yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          Activity Feed
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {initialEvents.map((event) => {
            const dotClass = severityDotColor[event.severity] ?? severityDotColor.info;
            const badgeClass =
              eventTypeBadgeColor[event.event_type] ??
              'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';

            return (
              <li
                key={event.id}
                className="flex items-start gap-3 text-sm"
              >
                {/* Severity dot */}
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    dotClass,
                  )}
                  aria-label={event.severity}
                />

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {relativeTime(event.occurred_at)}
                    </span>
                    <Badge
                      variant="secondary"
                      className={cn('text-xs', badgeClass)}
                    >
                      {event.event_type.replace(/_/g, ' ')}
                    </Badge>
                  </div>

                  <p className="text-sm">{event.summary}</p>

                  {event.links.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {event.links.map((link, j) => (
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
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
