import {
  getLatestBriefing,
  getActiveRuns,
  getNeedsAttention,
  getUpNext,
  getActivityFeed,
  refreshLivePanels,
} from '@/actions/briefing';
import { BriefingCard } from '@/components/briefing/briefing-card';
import type { Briefing } from '@/components/briefing/briefing-card';
import { LivePanels } from '@/components/briefing/live-panels';
import { ActivityFeed } from '@/components/briefing/activity-feed';
import { BriefingRealtime } from '@/components/briefing/briefing-realtime';

export default async function BriefingPage() {
  const [rawBriefing, activeRuns, needsAttention, upNext, rawEvents] =
    await Promise.all([
      getLatestBriefing(),
      getActiveRuns(),
      getNeedsAttention(),
      getUpNext(),
      getActivityFeed(),
    ]);

  // Cast Json fields to typed arrays for components
  const briefing: Briefing | null = rawBriefing
    ? {
        status_line: rawBriefing.status_line,
        changes: (rawBriefing.changes ?? []) as unknown as Briefing['changes'],
        attention: (rawBriefing.attention ?? []) as unknown as Briefing['attention'],
        forecast: rawBriefing.forecast,
        generated_at: rawBriefing.generated_at,
      }
    : null;

  const activityEvents = rawEvents.map((e) => ({
    ...e,
    links: (e.links ?? []) as { label: string; url: string }[],
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Briefing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI-generated summary and live system status.
        </p>
      </div>

      <BriefingRealtime />

      <BriefingCard briefing={briefing} />

      <LivePanels
        activeRuns={activeRuns}
        needsAttention={needsAttention}
        upNext={upNext}
        refreshAction={refreshLivePanels}
      />

      <ActivityFeed initialEvents={activityEvents} />
    </div>
  );
}
