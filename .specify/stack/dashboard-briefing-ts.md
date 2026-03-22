---
id: STACK-AC-DASHBOARD-BRIEFING
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-DASHBOARD
code_paths:
  - packages/dashboard/app/(dashboard)/briefing/page.tsx
  - packages/dashboard/components/briefing/
  - packages/dashboard/actions/briefing.ts
  - packages/briefing-summarizer/
  - supabase/migrations/009_briefing.sql
test_paths:
  - packages/dashboard/components/briefing/**/*.test.tsx
  - packages/dashboard/actions/briefing.test.ts
  - packages/briefing-summarizer/**/*.test.ts
  - supabase/tests/rls-briefing.test.ts
---

# STACK-AC-DASHBOARD-BRIEFING — Briefing Page & Summarizer (TypeScript)

## Pattern

**Server-rendered page with client-side auto-refresh and a standalone summarizer process.** The `/briefing` page is a Next.js server component that loads the latest Briefing, live panels, and ActivityEvents. Client components handle 30s auto-refresh for live panels and Supabase Realtime subscriptions for new Briefings. The summarizer is a separate Node.js process (not part of the Next.js app or daemon) that runs on a configurable interval (default 5 min), collects signals from four sources in parallel, calls a low-cost model for structured summarization, and writes results to Supabase. This separation was chosen over embedding in the daemon (which shouldn't own AI summarization per L2 system boundaries) and over a Next.js cron route (which couples page-serving with background processing).

## Key Decisions

**Database: three new tables.** `briefings` (id uuid PK, status_line text, changes/attention JSONB arrays, forecast text, signal_snapshot JSONB, generated_at timestamp). `activity_events` (id uuid PK, occurred_at timestamp, event_type, severity, summary, links JSONB). `notification_channel_configs` (id uuid PK, channel_type, target, events array — schema only, no implementations per L1). All append-only from the summarizer. RLS: authenticated users SELECT, service-role INSERTs.

**Model: Claude Haiku via `@anthropic-ai/sdk`.** Haiku is sufficient for structured summarization and keeps cost under $1/day at 5-minute intervals. Structured output via `tool_use` with `tool_choice: { type: 'tool' }` guarantees response matches the Briefing schema. Chosen over JSON mode (less reliable schema adherence) and Sonnet (unnecessary cost for summarization).

**Signal collection: four parallel queries per L2.** Runs table (in-progress, stuck, completed since last briefing), daemon status endpoint, git log since last briefing, pipeline heartbeat timestamp. Partial failure produces a degraded briefing with a gap note rather than no briefing (per L2 error handling). The `since` timestamp is the previous Briefing's `generated_at` queried from Supabase. On first run (no previous Briefing), `since` defaults to 24 hours ago to capture recent activity without flooding.

**Signal snapshot shape.** The `signal_snapshot` JSONB stores the raw input the summarizer consumed: `{ runs: Run[], daemonStatus: object | null, gitLog: string[], heartbeatAt: string | null, gaps: string[] }`. Retained for debugging — never displayed in the UI.

**ActivityEvent extraction.** The summarizer compares current signal state against the previous Briefing's `signal_snapshot` to detect state transitions. For each run whose `outcome` or `phase` changed, it writes an ActivityEvent. Merges are detected from git log entries not present in the previous snapshot. Errors come from runs with `outcome: 'stuck'`. Each ActivityEvent includes contextual `links` (GitHub issue URL, PR URL, or commit URL).

**Live panels: three server actions.** `getActiveRuns()` queries in-progress runs. `getNeedsAttention()` returns blocked/review/failed items sorted by urgency (blocked > review > failure). `getUpNext()` queries issues labeled with pipeline-stage labels (`feature-pipeline`, `ready-to-implement`, `l3-approved`, etc.) that have no in-progress run, ordered by label priority. Auto-refresh uses a client `useEffect` interval (configurable via `NEXT_PUBLIC_REFRESH_INTERVAL_MS`, default 30s).

**Notification dispatch stub (future).** On each cycle, the summarizer queries `notification_channel_configs`. If zero rows, skip dispatch (current behavior). When channels are implemented, attention items are evaluated against each channel's `events` array and dispatched accordingly. The query is present but the dispatch is a no-op.

**Stale indicator: 2x interval threshold.** If `generated_at` is older than 2× the configured interval, the UI shows a stale badge. Live panels continue independently since they query structured data, not the AI summary.

**Activity feed: cursor-based pagination.** Most recent 50 events by default (configurable via `NEXT_PUBLIC_ACTIVITY_PAGE_SIZE`), paginated on `occurred_at`. Cursor-based (not offset) to avoid skipping events inserted during pagination. Each event renders its `summary` and `links` as clickable anchors to GitHub Issues, PRs, or commits.

**Display ordering.** The briefing page renders sections top-to-bottom: AI Briefing (status line → changes → attention → forecast), then the three live panels (Active Now, Needs Attention, Up Next), then the Activity Feed. This ordering prioritizes the synthesized summary over raw data, matching the L1 "catch up in under 30 seconds" intent.

**Empty state: idle messaging per L1.** When all three live panels return zero results and no briefing exists yet, the page shows a clear idle state: "System idle — no active work, nothing queued." Each panel independently renders its own empty placeholder when its query returns no rows. The AI briefing section shows "No briefing generated yet" when no Briefing record exists.

**Deployment: fourth Docker Compose service.** The summarizer runs as `briefing-summarizer` alongside Caddy, dashboard, and daemon on the shared Docker network. It uses the same service-role key as the daemon for Supabase writes.

## Examples

```typescript
// Summarizer structured output — the key pattern
const response = await anthropic.messages.create({
  model: 'claude-haiku-4-5-20251001',
  tools: [{ name: 'produce_briefing', input_schema: briefingSchema }],
  tool_choice: { type: 'tool', name: 'produce_briefing' },
  messages: [{ role: 'user', content: signalPrompt }],
});
```

```typescript
// Parallel signal collection
const [runs, daemonStatus, gitLog, heartbeat] = await Promise.all([
  supabase.from('runs').select('*').gte('updated_at', since),
  fetch(`${DAEMON_URL}/status`).then(r => r.json()).catch(() => null),
  execGitLog(since),
  checkHeartbeat(),
]);
```

```typescript
// Realtime subscription for new briefings (client component)
supabase.channel('briefings').on('postgres_changes',
  { event: 'INSERT', schema: 'public', table: 'briefings' },
  (payload) => setLatestBriefing(payload.new)
).subscribe();
```

```typescript
// Needs-attention urgency sort
const urgencyOrder = { blocked: 0, review: 1, failure: 2 };
items.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);
```

```typescript
// Changes array element shape (JSONB)
// { summary: "Issue #42 moved to implementation", links: [{label, url}] }
// Attention item shape (JSONB)
// { issueNumber: 42, reason: "blocked", waitDuration: "2h", actionLinks: [{label, url}] }
```

```typescript
// Auto-refresh for live panels (client component)
useEffect(() => {
  const id = setInterval(() => refreshPanels(), refreshMs);
  return () => clearInterval(id);
}, [refreshMs]);
```

## Gotchas

- The summarizer must use the service-role key to write to Supabase. The anon key cannot INSERT into `briefings` or `activity_events` due to RLS.
- Git log collection requires repo access. Mount the repo volume into the summarizer container or use the GitHub API as fallback. If git is unavailable, note the gap in the briefing per L2 error handling.
- The `attention` and `changes` columns are JSONB arrays. Validate structure before inserting — malformed model output must not corrupt the table.
- Supabase Realtime for `briefings` requires an RLS SELECT policy for authenticated users. Without it, realtime events are silently dropped.
- If the model call fails, log and skip the cycle — do not write a partial briefing. The dashboard shows the stale indicator.
- `notification_channel_configs` table has no write RLS policies and no application code — this prevents accidental use before channel implementations exist.
- The summarizer's `DAEMON_URL` in Docker is `http://daemon:3847` (Docker service name resolution, same as dashboard).
- Summarizer interval uses `setInterval` with graceful SIGTERM handling: clear interval, wait for in-flight call, then exit.
