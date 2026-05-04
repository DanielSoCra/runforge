import type { ToolEntry } from './registry.js';

export interface CalendarClient {
  read(): Promise<unknown>;
}

export function createCalendarToolHandlers(
  options: { client: CalendarClient },
): Record<'cal_read', ToolEntry['handler']> {
  return {
    cal_read: async () => options.client.read(),
  };
}
