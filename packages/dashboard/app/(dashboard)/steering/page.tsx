import { getLatestBriefing } from '@/actions/briefing';
import { BriefingCard, type Briefing } from '@/components/briefing/briefing-card';
import { BriefingRealtime } from '@/components/briefing/briefing-realtime';
import {
  DecisionInbox,
  type RankedListItem,
} from '@/components/decisions/decision-inbox';
import { DaemonControls } from '@/components/steering/daemon-controls';
import { isDashboardAdmin } from '@/lib/auth/require-session';
import { daemonFetch } from '@/lib/daemon-fetch';

export const dynamic = 'force-dynamic';

/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — the operator surface (steering pane).
 *
 * Per FUNC-AC-OPERATOR-SURFACE the operator surface is a CALM pane of decisions
 * + briefing ONLY — not bolted onto the management home (StatsCards + RunTable
 * are governed by the separate FUNC-AC-DASHBOARD and stay on `/`). This route
 * renders the briefing followed by the ranked pending-decisions inbox, nothing
 * else.
 */

/**
 * Read the ranked pending-decisions inbox from the daemon Decision API
 * (STACK-AC-OPERATOR-SURFACE-API). FAIL-SAFE: any daemon 503 / unreachable /
 * DaemonConfigError / non-JSON body degrades to `{ items: [], unavailable: true }`
 * so the surface renders a calm degraded panel, never crashes
 * (STACK-AC-OPERATOR-SURFACE-CLIENT). The browser-facing equivalent is the proxy
 * route `app/api/decisions/pending/route.ts`.
 */
async function readDecisionInbox(): Promise<{
  items: RankedListItem[];
  unavailable: boolean;
}> {
  try {
    const res = await daemonFetch('/decisions/pending', { cache: 'no-store' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null) return { items: [], unavailable: true };
    const items: RankedListItem[] = Array.isArray(json)
      ? (json as RankedListItem[])
      : ((json.items ?? []) as RankedListItem[]);
    return { items, unavailable: false };
  } catch (err) {
    console.error(
      '[decisions-inbox] unreachable:',
      err instanceof Error ? err.message : err,
    );
    return { items: [], unavailable: true };
  }
}

export default async function SteeringPage() {
  const [rawBriefing, inbox, isAdmin] = await Promise.all([
    // FAIL-SAFE: the briefing is DB-backed; a store hiccup must NOT take down the
    // decision inbox (the most important thing on the calm pane, per
    // FUNC-AC-OPERATOR-SURFACE). Degrade the briefing to null on error — exactly as
    // readDecisionInbox degrades the inbox on a daemon failure — never 500 the pane.
    getLatestBriefing().catch((err) => {
      console.error(
        '[steering] briefing unavailable:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }),
    readDecisionInbox(),
    isDashboardAdmin().catch((err) => {
      console.error(
        '[steering] admin check failed:',
        err instanceof Error ? err.message : err,
      );
      return false;
    }),
  ]);

  // Cast Json fields to typed arrays for BriefingCard — mirrors the briefing
  // route's projection of the raw store record.
  const briefing: Briefing | null = rawBriefing
    ? {
        status_line: rawBriefing.status_line,
        changes: (rawBriefing.changes ?? []) as unknown as Briefing['changes'],
        attention: (rawBriefing.attention ?? []) as unknown as Briefing['attention'],
        forecast: rawBriefing.forecast,
        generated_at: rawBriefing.generated_at,
      }
    : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold mb-1">Steering</h1>
        <p className="text-muted-foreground text-sm">
          Decisions awaiting you and the latest briefing.
        </p>
      </div>
      {/* Periodic refresh keeps the calm pane current without an answer-triggered
          refresh, which would race the resume loop (decision-answer.tsx:250-257). */}
      <BriefingRealtime />
      {/* Emergency daemon controls: admin-only, confirm-gated halt. */}
      <DaemonControls isAdmin={isAdmin} />
      {/* The calm operator pane: briefing + decisions, nothing else
          (FUNC-AC-OPERATOR-SURFACE: "decisions and the briefing"). */}
      <BriefingCard briefing={briefing} />
      <div>
        <h2 className="text-lg font-medium mb-4">Decisions</h2>
        <DecisionInbox items={inbox.items} unavailable={inbox.unavailable} />
      </div>
    </div>
  );
}
