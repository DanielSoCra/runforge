import type { ToolEntry } from './registry.js';

export interface ObserverClient {
  recentActivity(): Promise<unknown>;
  daemonState(): Promise<unknown>;
}

export function createObserverToolHandlers(
  options: { client: ObserverClient },
): Record<'obs_recent_activity' | 'obs_daemon_state', ToolEntry['handler']> {
  return {
    obs_recent_activity: async () => options.client.recentActivity(),
    obs_daemon_state: async () => options.client.daemonState(),
  };
}
