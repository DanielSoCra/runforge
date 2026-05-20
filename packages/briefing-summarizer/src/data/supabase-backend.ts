import type { SupabaseClient } from '@supabase/supabase-js';

import type { ActivityEventInsert } from '../events.js';
import type { SignalResult } from '../signals.js';
import type {
  BriefingDataBackend,
  BriefingOutput,
  StoredPreviousBriefing,
} from './types.js';

export function createSupabaseBriefingBackend(
  supabase: SupabaseClient,
): BriefingDataBackend {
  return {
    async getPreviousBriefing() {
      const { data, error } = await supabase
        .from('briefings')
        .select(
          'status_line, changes, attention, forecast, signal_snapshot, generated_at',
        )
        .order('generated_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) return null;
      return data as StoredPreviousBriefing;
    },

    async listRunsSince(since: string) {
      const { data, error } = await supabase
        .from('runs')
        .select('*')
        .gte('updated_at', since);

      if (error) {
        throw new Error(`Supabase runs query failed: ${error.message}`);
      }
      return (data ?? []) as Record<string, unknown>[];
    },

    async writeBriefing(
      briefing: BriefingOutput,
      signalSnapshot: SignalResult,
    ) {
      const { error } = await supabase.from('briefings').insert({
        status_line: briefing.status_line,
        changes: briefing.changes,
        attention: briefing.attention,
        forecast: briefing.forecast,
        signal_snapshot: signalSnapshot,
        generated_at: new Date().toISOString(),
      });

      if (error) {
        throw new Error(`Failed to write briefing: ${error.message}`);
      }
    },

    async writeActivityEvents(events: ActivityEventInsert[]) {
      if (events.length === 0) return;

      const { error } = await supabase.from('activity_events').insert(events);

      if (error) {
        throw new Error(`Failed to write activity events: ${error.message}`);
      }
    },

    async countNotificationChannels() {
      const { data, error } = await supabase
        .from('notification_channel_configs')
        .select('id');

      if (error) {
        throw new Error(
          `Failed to query notification channels: ${error.message}`,
        );
      }

      return data?.length ?? 0;
    },
  };
}
