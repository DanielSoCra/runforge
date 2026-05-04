import { describe, expect, it } from 'vitest';
import { createInMemoryMigrationStore } from './sqlite.js';
import {
  CONCIERGE_STATE_MIGRATIONS,
  REQUIRED_STATE_TABLES,
  applyConciergeStateSchemaMigrations,
} from './state-schema.js';

describe('concierge state schema migrations', () => {
  it('declares the runtime tables required by ARCH-CONCIERGE-RUNTIME', () => {
    const sql = CONCIERGE_STATE_MIGRATIONS.map((migration) => migration.sql).join('\n');

    for (const table of REQUIRED_STATE_TABLES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_confirmations_pending');
    expect(sql).toContain('WHERE status = \'pending\'');
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it('models confirmation lifecycle columns from ARCH-CONFIRMATION-LIFECYCLE', () => {
    const sql = CONCIERGE_STATE_MIGRATIONS[0]?.sql ?? '';

    expect(sql).toContain('tool_call_id TEXT NOT NULL');
    expect(sql).toContain('conversation_id TEXT NOT NULL');
    expect(sql).toContain('tool_name TEXT NOT NULL');
    expect(sql).toContain('args TEXT NOT NULL');
    expect(sql).toContain('blast_reason TEXT NOT NULL');
    expect(sql).toContain('slack_message_ts TEXT');
    expect(sql).toContain('expires_at INTEGER NOT NULL');
  });

  it('applies schema migrations forward-only through the migration store', async () => {
    const store = createInMemoryMigrationStore();
    const executed: string[] = [];
    const executor = {
      exec: async (sql: string) => {
        executed.push(sql);
      },
    };

    await applyConciergeStateSchemaMigrations(store, executor);
    await applyConciergeStateSchemaMigrations(store, executor);

    expect(executed).toHaveLength(1);
    expect(store.appliedMigrationIds()).toEqual(['001-concierge-state-schema']);
  });
});
