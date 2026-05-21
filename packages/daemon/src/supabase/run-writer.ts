// Retired compatibility shim. Use PostgresRunWriter from ../data/run-writer.js.

export {
  toDbOutcome,
  toDbSessionType,
  type DbOutcome,
  type DbSessionType,
  type PhaseRecord,
  type RunRow,
  type RunWriterOutcome,
} from '../data/run-writer.js';

export class SupabaseRunWriter {
  constructor(_client?: unknown) {}

  async insertRun(_runId?: string, _data?: unknown): Promise<void> {
    this.warnRetired();
  }

  async upsertRun(_runId?: string, _patch?: unknown): Promise<void> {
    this.warnRetired();
  }

  async writeCostEvent(
    _runId?: string,
    _sessionType?: unknown,
    _cost?: number,
  ): Promise<void> {
    this.warnRetired();
  }

  private warnRetired(): void {
    console.warn(
      '[run-writer] SupabaseRunWriter is retired; use PostgresRunWriter',
    );
  }
}
