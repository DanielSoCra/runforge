import type { MigrationStore, Migration } from './sqlite.js';
import { runForwardOnlyMigrations } from './sqlite.js';

export interface SqlExecutor {
  exec(sql: string): Promise<void> | void;
}

export interface StateSchemaMigration {
  id: string;
  sql: string;
}

export const REQUIRED_STATE_TABLES = [
  'schema_migrations',
  'conversations',
  'messages',
  'tool_calls',
  'confirmations',
  'events',
  'cards',
] as const;

export const CONCIERGE_STATE_MIGRATIONS: StateSchemaMigration[] = [
  {
    id: '001-concierge-state-schema',
    sql: `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  cost REAL,
  confirmation_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation
  ON tool_calls (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  conversation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,
  blast_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  slack_message_ts TEXT,
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_confirmations_pending
  ON confirmations (status, expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created
  ON events (created_at);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  confirmation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_status
  ON cards (status, updated_at);
`.trim(),
  },
];

export async function applyConciergeStateSchemaMigrations(
  store: MigrationStore,
  executor: SqlExecutor,
): Promise<void> {
  const migrations: Migration[] = CONCIERGE_STATE_MIGRATIONS.map((migration) => ({
    id: migration.id,
    up: async () => {
      await executor.exec(migration.sql);
    },
  }));
  await runForwardOnlyMigrations(store, migrations);
}
