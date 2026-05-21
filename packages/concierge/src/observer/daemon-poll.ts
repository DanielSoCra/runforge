import type { ConciergeEventStore } from '../memory/state-stores.js';

export interface DaemonStatusClient {
  status(): Promise<unknown>;
}

export interface DaemonStatusPoller {
  pollOnce(): Promise<boolean>;
}

export interface DaemonStatusPollerOptions {
  client: DaemonStatusClient;
  events: ConciergeEventStore;
}

export interface DaemonStatusHttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export function createDaemonStatusPoller(options: DaemonStatusPollerOptions): DaemonStatusPoller {
  let lastFingerprint: string | undefined;

  return {
    async pollOnce(): Promise<boolean> {
      const event = await readDaemonEvent(options.client);
      const fingerprint = JSON.stringify(event);
      if (fingerprint === lastFingerprint) return false;
      lastFingerprint = fingerprint;
      options.events.append({
        source: 'observer',
        status: 'new',
        ...event,
      });
      return true;
    },
  };
}

export function createDaemonStatusHttpClient(options: DaemonStatusHttpClientOptions): DaemonStatusClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  return {
    async status(): Promise<unknown> {
      const response = await fetchImpl(`${baseUrl}/status`, { method: 'GET' });
      if (!response.ok) throw new Error(`daemon status failed: ${response.status}`);
      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text) as unknown;
    },
  };
}

async function readDaemonEvent(client: DaemonStatusClient): Promise<{ type: string; payload: unknown }> {
  try {
    const status = await client.status();
    const payload = daemonStatusMetadata(status);
    return {
      type: daemonEventType(payload),
      payload,
    };
  } catch (error) {
    return {
      type: 'daemon_unreachable',
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function daemonStatusMetadata(status: unknown): Record<string, unknown> {
  if (!isRecord(status)) return {};
  const metadata: Record<string, unknown> = {};
  copyKnown(metadata, status, 'paused', 'boolean');
  copyKnown(metadata, status, 'draining', 'boolean');
  copyKnown(metadata, status, 'activeRuns', 'number');
  copyKnown(metadata, status, 'dailyCost', 'number');
  copyKnown(metadata, status, 'consecutiveStuckCount', 'number');
  if (Array.isArray(status.activeIssues)) metadata.activeIssues = status.activeIssues;
  return metadata;
}

function daemonEventType(payload: Record<string, unknown>): string {
  if (typeof payload.consecutiveStuckCount === 'number' && payload.consecutiveStuckCount > 0) {
    return 'daemon_stuck';
  }
  if (payload.paused === true) return 'daemon_paused';
  if (typeof payload.activeRuns === 'number' && payload.activeRuns > 0) return 'daemon_active';
  return 'daemon_status_snapshot';
}

function copyKnown(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  type: 'boolean' | 'number',
): void {
  if (typeof source[key] === type) target[key] = source[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
