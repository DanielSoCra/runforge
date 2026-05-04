import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDailyActivityConsolidator } from './consolidator.js';
import { startDailyActivityConsolidatorProcess } from './consolidator-main.js';
import { openConciergeStateDatabase, type ConciergeStateDatabase } from './node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from './state-schema.js';
import { createConciergeStateStores } from './state-stores.js';

describe('daily activity consolidator', () => {
  it('writes a metadata-only daily summary and omits raw message text and tool args', async () => {
    const dayStart = new Date(2026, 4, 3).getTime();
    let now = dayStart + 9 * 60 * 60 * 1_000;
    let nextId = 0;
    const db = await openMigratedDb(await createStateDbPath());
    const stores = createConciergeStateStores(db, {
      now: () => now,
      createId: () => `id-${++nextId}`,
    });
    const conversation = stores.conversations.startConversation('client secret payload');
    stores.conversations.appendTurn(conversation.id, 'assistant', 'assistant private answer');
    stores.auditLog.record({
      conversationId: conversation.id,
      toolName: 'mail_draft',
      args: { to: 'client@example.com', body: 'private draft' },
      status: 'allowed',
    });
    stores.events.append({
      source: 'observer',
      type: 'daemon_stuck',
      payload: { issue: 504 },
      status: 'new',
    });
    stores.cards.upsert({
      id: 'card-1',
      status: 'needs_decision',
      title: 'Needs review',
      body: 'details omitted',
    });

    const writes: Array<{ date: string; body: string }> = [];
    const consolidator = createDailyActivityConsolidator({
      db,
      writer: {
        writeDailySummary: async (input) => {
          writes.push(input);
          return { path: `/vault/10-projects/concierge/daily-summaries/${input.date}.md` };
        },
      },
      now: () => new Date(2026, 4, 4, 3).getTime(),
    });

    const result = await consolidator.runOnce();

    expect(result).toEqual({
      date: '2026-05-03',
      rawRecordsPruned: 0,
      summaryWritten: true,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.date).toBe('2026-05-03');
    expect(writes[0]?.body).toContain('# Concierge daily summary: 2026-05-03');
    expect(writes[0]?.body).toContain('- Conversations touched: 1');
    expect(writes[0]?.body).toContain('- operator turns: 1');
    expect(writes[0]?.body).toContain('- assistant turns: 1');
    expect(writes[0]?.body).toContain('- mail_draft allowed: 1');
    expect(writes[0]?.body).toContain('- daemon_stuck new: 1');
    expect(writes[0]?.body).toContain('- needs_decision: 1');
    expect(writes[0]?.body).not.toContain('client secret payload');
    expect(writes[0]?.body).not.toContain('client@example.com');
    expect(writes[0]?.body).not.toContain('private draft');
    expect(writes[0]?.body).not.toContain('assistant private answer');
    db.close();
  });

  it('prunes raw recent activity older than the retention window only after the summary write succeeds', async () => {
    const db = await openMigratedDb(await createStateDbPath());
    let now = new Date(2026, 3, 1).getTime();
    const ids = ['conversation-old', 'turn-old', 'tool-old', 'conversation-new', 'turn-new'];
    const stores = createConciergeStateStores(db, {
      now: () => now,
      createId: () => ids.shift() ?? 'extra-id',
    });
    const oldConversation = stores.conversations.startConversation('old');
    stores.auditLog.record({
      conversationId: oldConversation.id,
      toolName: 'ac_status',
      args: {},
      status: 'allowed',
    });
    stores.events.append({
      source: 'observer',
      type: 'manual_commit',
      payload: {},
      status: 'new',
    });
    stores.cards.upsert({
      id: 'card-old',
      status: 'done',
      title: 'Old done card',
      body: 'old',
    });
    now = new Date(2026, 4, 3).getTime();
    stores.conversations.startConversation('new');

    const failing = createDailyActivityConsolidator({
      db,
      writer: {
        writeDailySummary: async () => {
          throw new Error('vault unavailable');
        },
      },
      now: () => new Date(2026, 4, 4, 3).getTime(),
    });
    await expect(failing.runOnce()).rejects.toThrow('vault unavailable');
    expect(stores.conversations.getConversation('conversation-old')).toBeDefined();
    expect(stores.auditLog.get('tool-old')).toBeDefined();

    const succeeding = createDailyActivityConsolidator({
      db,
      writer: {
        writeDailySummary: async () => ({ path: '/vault/summary.md' }),
      },
      now: () => new Date(2026, 4, 4, 3).getTime(),
    });

    const result = await succeeding.runOnce();

    expect(result.rawRecordsPruned).toBe(4);
    expect(stores.conversations.getConversation('conversation-old')).toBeUndefined();
    expect(stores.auditLog.get('tool-old')).toBeUndefined();
    expect(stores.events.list()).toEqual([]);
    expect(stores.cards.get('card-old')).toBeUndefined();
    expect(stores.conversations.getConversation('conversation-new')).toBeDefined();
    db.close();
  });

  it('writes daily summary files under the configured vault summary location', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concierge-summary-vault-'));
    const db = await openMigratedDb(await createStateDbPath());
    const consolidator = createDailyActivityConsolidator({
      db,
      writer: {
        vaultPath: dir,
        summaryPathPrefix: '10-projects/concierge/daily-summaries',
      },
      now: () => new Date(2026, 4, 4, 3).getTime(),
    });

    await consolidator.runOnce();

    const path = join(dir, '10-projects/concierge/daily-summaries/2026-05-03.md');
    expect(await readFile(path, 'utf-8')).toContain('# Concierge daily summary: 2026-05-03');
    db.close();
  });

  it('runs as an occasional process that opens state, migrates, writes, and closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'concierge-consolidator-process-'));
    const vaultPath = join(dir, 'vault');
    const stateDbPath = join(dir, 'state.db');

    const result = await startDailyActivityConsolidatorProcess({
      stateDbPath,
      loadConfig: async () => ({
        slackBotToken: 'xoxb-token',
        slackSigningSecret: 'secret',
        operatorSlackUserId: 'U123',
        anthropicApiKey: 'sk-test',
        modelId: 'claude-sonnet-4-6',
        tunnelHostname: 'concierge.example.com',
        boardHostname: 'board.example.com',
        vaultPath,
        watchedRepos: ['/repo'],
        operatorEmail: 'operator@example.com',
        autoClaudeBaseUrl: 'http://127.0.0.1:3847',
      }),
      now: () => new Date(2026, 4, 4, 3).getTime(),
      logger: {
        log: vi.fn(),
        error: vi.fn(),
      },
    });

    expect(result.date).toBe('2026-05-03');
    expect(await readFile(
      join(vaultPath, '10-projects/concierge/daily-summaries/2026-05-03.md'),
      'utf-8',
    )).toContain('# Concierge daily summary: 2026-05-03');

    const reopened = openConciergeStateDatabase(stateDbPath);
    expect(reopened.appliedMigrationIds()).toEqual(['001-concierge-state-schema']);
    reopened.close();
  });
});

async function createStateDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-consolidator-'));
  return join(dir, 'state.db');
}

async function openMigratedDb(path: string): Promise<ConciergeStateDatabase> {
  const db = openConciergeStateDatabase(path);
  await applyConciergeStateSchemaMigrations(db, db);
  return db;
}
