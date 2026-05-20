import type { ActivityEventInsert, PreviousSnapshot } from '../events.js';
import type { PreviousBriefing } from '../prompt.js';
import type { SignalResult } from '../signals.js';

export interface BriefingOutput {
  status_line: string;
  changes: unknown[];
  attention: unknown[];
  forecast: string;
}

export type StoredPreviousBriefing = PreviousBriefing & {
  signal_snapshot: PreviousSnapshot;
};

export interface BriefingDataBackend {
  getPreviousBriefing(): Promise<StoredPreviousBriefing | null>;
  listRunsSince(since: string): Promise<Record<string, unknown>[]>;
  writeBriefing(
    briefing: BriefingOutput,
    signalSnapshot: SignalResult,
  ): Promise<void>;
  writeActivityEvents(events: ActivityEventInsert[]): Promise<void>;
  countNotificationChannels(): Promise<number>;
  close?(): Promise<void>;
}
