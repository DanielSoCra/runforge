import type {
  ConciergeCardStore,
  ConciergeEventRecord,
  ConciergeEventStore,
} from '../memory/state-stores.js';

export type EventOutcome = 'surface_card' | 'slack_dm' | 'silent_log';

export interface EventCardClassification {
  outcomes: EventOutcome[];
  card?: {
    status: string;
    title: string;
    body: string;
  };
}

export interface EventCardMaterializer {
  processOnce(): number;
}

export interface EventCardMaterializerOptions {
  events: ConciergeEventStore;
  cards: ConciergeCardStore;
}

export function classifyConciergeEvent(event: ConciergeEventRecord): EventCardClassification {
  switch (event.type) {
    case 'daemon_stuck':
      return {
        outcomes: ['surface_card', 'slack_dm'],
        card: {
          status: 'needs_decision',
          title: 'Daemon stuck',
          body: summarizePayload(event.payload, ['consecutiveStuckCount', 'activeIssues']),
        },
      };
    case 'daemon_run_completed':
      return classifyDaemonRunCompleted(event.payload);
    case 'daemon_unreachable':
    case 'daemon_paused':
    case 'daily_cost_threshold_crossed':
    case 'confirmation_expired':
      return { outcomes: ['slack_dm'] };
    case 'manual_branch_created':
    case 'manual_commit':
    case 'pr_opened':
    case 'slack_message_sent_to_external_channel':
    case 'daemon_status_snapshot':
    case 'daemon_active':
      return { outcomes: ['silent_log'] };
    default:
      return { outcomes: ['silent_log'] };
  }
}

export function createEventCardMaterializer(
  options: EventCardMaterializerOptions,
): EventCardMaterializer {
  let lastProcessedEventId = 0;

  return {
    processOnce(): number {
      let materialized = 0;
      for (const event of options.events.list()) {
        if (event.id <= lastProcessedEventId) continue;
        lastProcessedEventId = Math.max(lastProcessedEventId, event.id);
        const classification = classifyConciergeEvent(event);
        if (!classification.card) continue;
        options.cards.upsert({
          id: `event-${event.id}`,
          ...classification.card,
        });
        materialized += 1;
      }
      return materialized;
    },
  };
}

function classifyDaemonRunCompleted(payload: unknown): EventCardClassification {
  if (hasConcerns(payload)) {
    return {
      outcomes: ['surface_card'],
      card: {
        status: 'needs_decision',
        title: 'Daemon run needs review',
        body: summarizePayload(payload, ['issue', 'status', 'concerns']),
      },
    };
  }
  return { outcomes: ['silent_log'] };
}

function hasConcerns(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (Array.isArray(payload.concerns) && payload.concerns.length > 0) return true;
  return payload.status === 'completed-with-concerns';
}

function summarizePayload(payload: unknown, preferredKeys: string[]): string {
  if (!isRecord(payload)) return 'metadata unavailable';
  const pairs: string[] = [];
  for (const key of preferredKeys) {
    if (payload[key] !== undefined) pairs.push(`${key}: ${formatValue(payload[key])}`);
  }
  if (pairs.length > 0) return pairs.join('; ');
  const keys = Object.keys(payload).sort();
  return keys.map((key) => `${key}: ${formatValue(payload[key])}`).join('; ') || 'metadata unavailable';
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'none';
  return '[metadata]';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
