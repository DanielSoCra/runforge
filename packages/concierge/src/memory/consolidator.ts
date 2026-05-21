import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { ConciergeStateDatabase, SqlParameter } from './node-sqlite.js';

export interface DailySummaryInput {
  date: string;
  body: string;
}

export interface DailySummaryWriter {
  writeDailySummary(input: DailySummaryInput): Promise<unknown>;
}

export interface FileDailySummaryWriterOptions {
  vaultPath: string;
  summaryPathPrefix?: string;
}

export interface DailyActivityConsolidatorOptions {
  db: ConciergeStateDatabase;
  writer: DailySummaryWriter | FileDailySummaryWriterOptions;
  now?: () => number;
  retentionMs?: number;
}

export interface DailyActivityConsolidationResult {
  date: string;
  summaryWritten: boolean;
  rawRecordsPruned: number;
}

export interface DailyActivityConsolidator {
  runOnce(): Promise<DailyActivityConsolidationResult>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_SUMMARY_PATH_PREFIX = '10-projects/concierge/daily-summaries';

export function createDailyActivityConsolidator(
  options: DailyActivityConsolidatorOptions,
): DailyActivityConsolidator {
  const now = options.now ?? Date.now;
  const writer = 'writeDailySummary' in options.writer
    ? options.writer
    : createDailySummaryFileWriter(options.writer);

  return {
    async runOnce(): Promise<DailyActivityConsolidationResult> {
      const window = previousLocalDayWindow(now());
      const body = buildDailySummary(options.db, window);
      await writer.writeDailySummary({ date: window.date, body });
      const rawRecordsPruned = pruneRawActivityBefore(
        options.db,
        now() - (options.retentionMs ?? DEFAULT_RETENTION_MS),
      );
      return {
        date: window.date,
        summaryWritten: true,
        rawRecordsPruned,
      };
    },
  };
}

export function createDailySummaryFileWriter(
  options: FileDailySummaryWriterOptions,
): DailySummaryWriter {
  const vaultRoot = resolve(options.vaultPath);
  const prefix = options.summaryPathPrefix ?? DEFAULT_SUMMARY_PATH_PREFIX;

  return {
    async writeDailySummary(input): Promise<{ path: string }> {
      const path = resolve(vaultRoot, prefix, `${input.date}.md`);
      assertInsideRoot(vaultRoot, path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body, 'utf-8');
      return { path };
    },
  };
}

interface DayWindow {
  date: string;
  startAt: number;
  endAt: number;
}

interface CountRow {
  count: number;
}

interface RoleCountRow {
  role: string;
  count: number;
}

interface ToolCountRow {
  tool_name: string;
  status: string;
  count: number;
}

interface EventCountRow {
  type: string;
  status: string;
  count: number;
}

interface CardCountRow {
  status: string;
  count: number;
}

function buildDailySummary(db: ConciergeStateDatabase, window: DayWindow): string {
  const conversationCount = countRows(
    db,
    `SELECT COUNT(DISTINCT conversation_id) AS count
     FROM messages
     WHERE created_at >= ? AND created_at < ?`,
    window.startAt,
    window.endAt,
  );
  const roleCounts = db.all<RoleCountRow>(
    `SELECT role, COUNT(*) AS count
     FROM messages
     WHERE created_at >= ? AND created_at < ?
     GROUP BY role
     ORDER BY role`,
    window.startAt,
    window.endAt,
  );
  const toolCounts = db.all<ToolCountRow>(
    `SELECT tool_name, status, COUNT(*) AS count
     FROM tool_calls
     WHERE created_at >= ? AND created_at < ?
     GROUP BY tool_name, status
     ORDER BY tool_name, status`,
    window.startAt,
    window.endAt,
  );
  const eventCounts = db.all<EventCountRow>(
    `SELECT type, status, COUNT(*) AS count
     FROM events
     WHERE created_at >= ? AND created_at < ?
     GROUP BY type, status
     ORDER BY type, status`,
    window.startAt,
    window.endAt,
  );
  const cardCounts = db.all<CardCountRow>(
    `SELECT status, COUNT(*) AS count
     FROM cards
     WHERE updated_at >= ? AND updated_at < ?
     GROUP BY status
     ORDER BY status`,
    window.startAt,
    window.endAt,
  );

  return [
    `# Concierge daily summary: ${window.date}`,
    '',
    `Window: ${formatLocalDateTime(window.startAt)} to ${formatLocalDateTime(window.endAt)} local time`,
    '',
    'Metadata-only summary. Raw message text, tool arguments, and client-sensitive content are intentionally omitted.',
    '',
    '## Conversations',
    `- Conversations touched: ${conversationCount}`,
    ...roleCounts.map((row) => `- ${row.role} turns: ${row.count}`),
    '',
    '## Tool Calls',
    ...emptyAware(toolCounts.map((row) => `- ${row.tool_name} ${row.status}: ${row.count}`)),
    '',
    '## Observer Events',
    ...emptyAware(eventCounts.map((row) => `- ${row.type} ${row.status}: ${row.count}`)),
    '',
    '## Board Cards',
    ...emptyAware(cardCounts.map((row) => `- ${row.status}: ${row.count}`)),
    '',
  ].join('\n');
}

function pruneRawActivityBefore(db: ConciergeStateDatabase, cutoff: number): number {
  const oldConversationCount = countRows(
    db,
    `SELECT COUNT(*) AS count
     FROM conversations AS c
     WHERE c.updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM messages AS m
         WHERE m.conversation_id = c.id AND m.created_at >= ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM tool_calls AS t
         WHERE t.conversation_id = c.id AND t.created_at >= ?
       )`,
    cutoff,
    cutoff,
    cutoff,
  );
  const oldToolCallCount = countRows(db, 'SELECT COUNT(*) AS count FROM tool_calls WHERE created_at < ?', cutoff);
  const oldEventCount = countRows(db, 'SELECT COUNT(*) AS count FROM events WHERE created_at < ?', cutoff);
  const oldClosedCardCount = countRows(
    db,
    `SELECT COUNT(*) AS count
     FROM cards
     WHERE updated_at < ? AND status IN ('dismissed', 'done', 'snoozed')`,
    cutoff,
  );

  db.run(
    `DELETE FROM confirmations
     WHERE created_at < ?
        OR tool_call_id IN (SELECT id FROM tool_calls WHERE created_at < ?)`,
    cutoff,
    cutoff,
  );
  db.run('DELETE FROM tool_calls WHERE created_at < ?', cutoff);
  db.run('DELETE FROM messages WHERE created_at < ?', cutoff);
  db.run(
    `DELETE FROM conversations
     WHERE updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM messages
         WHERE messages.conversation_id = conversations.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tool_calls
         WHERE tool_calls.conversation_id = conversations.id
       )`,
    cutoff,
  );
  db.run('DELETE FROM events WHERE created_at < ?', cutoff);
  db.run(
    `DELETE FROM cards
     WHERE updated_at < ? AND status IN ('dismissed', 'done', 'snoozed')`,
    cutoff,
  );

  return oldConversationCount + oldToolCallCount + oldEventCount + oldClosedCardCount;
}

function previousLocalDayWindow(now: number): DayWindow {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    date: formatLocalDate(start.getTime()),
    startAt: start.getTime(),
    endAt: end.getTime(),
  };
}

function countRows(db: ConciergeStateDatabase, sql: string, ...params: SqlParameter[]): number {
  return db.get<CountRow>(sql, ...params)?.count ?? 0;
}

function emptyAware(lines: string[]): string[] {
  return lines.length > 0 ? lines : ['- none'];
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-');
}

function formatLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${formatLocalDate(timestamp)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function assertInsideRoot(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (relativePath.startsWith('..') || relativePath === '..' || resolve(root, relativePath) !== path) {
    throw new Error('daily summary path is outside the configured vault');
  }
}
