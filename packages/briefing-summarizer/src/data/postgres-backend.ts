import {
  createDbClient,
  createPostgresStores,
  type ActivityEvent,
  type AutoClaudeStores,
  type Briefing,
  type JsonValue,
  type Run,
  type StoreResult,
} from '@auto-claude/db';

import type { ActivityEventInsert } from '../events.js';
import type { SignalResult } from '../signals.js';
import type {
  BriefingDataBackend,
  BriefingOutput,
  StoredPreviousBriefing,
} from './types.js';

export function createPostgresBriefingBackend(
  databaseUrl?: string,
): BriefingDataBackend {
  const client = createDbClient(databaseUrl ? { url: databaseUrl } : {});
  const stores = createPostgresStores(client.db);
  return createPostgresBriefingBackendFromStores(stores, async () => {
    await client.sql.end();
  });
}

export function createPostgresBriefingBackendFromStores(
  stores: Pick<AutoClaudeStores, 'briefings'>,
  close?: () => Promise<void>,
): BriefingDataBackend {
  return {
    async getPreviousBriefing() {
      const briefing = await stores.briefings.readLatestBriefing();
      if (!briefing.ok && briefing.error === 'not-found') return null;
      return toPreviousBriefing(requireStore(briefing, 'read latest briefing'));
    },

    async listRunsSince(since: string) {
      const rows = requireStore(
        await stores.briefings.listRunsForSignals(new Date(since)),
        'list runs for briefing signals',
      );
      return rows.map(toSignalRun);
    },

    async writeBriefing(
      briefing: BriefingOutput,
      signalSnapshot: SignalResult,
    ) {
      requireStore(
        await stores.briefings.appendBriefing({
          statusLine: briefing.status_line,
          changes: asJsonArray(briefing.changes),
          attention: asJsonArray(briefing.attention),
          forecast: briefing.forecast,
          signalSnapshot: asJsonRecord(signalSnapshot),
        }),
        'write briefing',
      );
    },

    async writeActivityEvents(events: ActivityEventInsert[]) {
      requireStore(
        await stores.briefings.appendActivityEvents(
          events.map(toPostgresActivityEvent),
        ),
        'write activity events',
      );
    },

    async countNotificationChannels() {
      return requireStore(
        await stores.briefings.countNotificationChannels(),
        'count notification channels',
      );
    },

    close,
  };
}

function requireStore<T>(result: StoreResult<T>, action: string): T {
  if (result.ok) return result.value;
  throw new Error(`${action} failed: ${result.error}: ${result.message}`);
}

function toPreviousBriefing(briefing: Briefing): StoredPreviousBriefing {
  return {
    status_line: briefing.statusLine,
    changes: asUnknownArray(briefing.changes),
    attention: asUnknownArray(briefing.attention),
    forecast: briefing.forecast,
    generated_at: briefing.generatedAt.toISOString(),
    signal_snapshot: briefing.signalSnapshot,
  };
}

function toSignalRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    repo_id: run.repoId,
    repo_owner: run.repoOwner,
    repo_name: run.repoName,
    issue_number: run.issueNumber,
    issue_title: run.issueTitle,
    pipeline_variant: run.pipelineVariant,
    current_phase: run.currentPhase,
    phase: run.currentPhase,
    outcome: run.outcome,
    total_cost: run.totalCost,
    phases: run.phases,
    fix_attempts: run.fixAttempts,
    report: run.report,
    active_plugins: run.activePlugins,
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
    updated_at: run.updatedAt.toISOString(),
  };
}

function toPostgresActivityEvent(
  event: ActivityEventInsert,
): Omit<ActivityEvent, 'id'> {
  return {
    occurredAt: new Date(event.occurred_at),
    eventType: event.event_type,
    severity: event.severity,
    summary: event.summary,
    links: event.links,
  };
}

function asJsonArray(value: unknown[]): JsonValue[] {
  return value as JsonValue[];
}

function asJsonRecord(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>;
}

function asUnknownArray(value: JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}
