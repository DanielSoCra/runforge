import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openConciergeStateDatabase, type ConciergeStateDatabase } from './node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from './state-schema.js';
import { createConciergeStateStores } from './state-stores.js';

describe('persistent concierge state stores', () => {
  it('persists conversation turns across database reopen', async () => {
    let now = 1_000;
    let nextId = 0;
    const dbPath = await createStateDbPath();
    const db = await openMigratedDb(dbPath);
    const stores = createConciergeStateStores(db, {
      now: () => now,
      createId: () => `id-${++nextId}`,
    });

    const conversation = stores.conversations.startConversation('hello');
    now = 2_000;
    stores.conversations.appendTurn(conversation.id, 'assistant', 'hi');
    db.close();

    const reopened = await openMigratedDb(dbPath);
    const persisted = createConciergeStateStores(reopened).conversations.getConversation(conversation.id);

    expect(persisted).toEqual({
      id: 'id-1',
      status: 'open',
      createdAt: 1_000,
      updatedAt: 2_000,
      turns: [
        { id: 'id-2', role: 'operator', text: 'hello', createdAt: 1_000 },
        { id: 'id-3', role: 'assistant', text: 'hi', createdAt: 2_000 },
      ],
    });
    reopened.close();
  });

  it('persists audit records and idempotent confirmation transitions', async () => {
    let now = 5_000;
    let nextId = 0;
    const db = await openMigratedDb(await createStateDbPath());
    const stores = createConciergeStateStores(db, {
      now: () => now,
      createId: () => `id-${++nextId}`,
    });
    const conversation = stores.conversations.startConversation('send the draft');

    const audit = stores.auditLog.record({
      conversationId: conversation.id,
      toolName: 'mail_send',
      args: { draftId: 'draft-1' },
      status: 'pending_confirmation',
    });
    const confirmation = stores.confirmations.create({
      toolCallId: audit.id,
      conversationId: conversation.id,
      toolName: 'mail_send',
      args: { draftId: 'draft-1' },
      blastReason: 'external email',
    });

    now = 6_000;
    stores.auditLog.update(audit.id, { confirmationId: confirmation.id });
    const approved = stores.confirmations.approve(confirmation.id);
    const duplicate = stores.confirmations.deny(confirmation.id);

    expect(approved.status).toBe('approved');
    expect(duplicate.status).toBe('approved');
    expect(stores.auditLog.get(audit.id)).toEqual(expect.objectContaining({
      confirmationId: confirmation.id,
      args: { draftId: 'draft-1' },
    }));
    expect(stores.confirmations.get(confirmation.id)).toEqual(expect.objectContaining({
      status: 'approved',
      respondedAt: 6_000,
    }));
    db.close();
  });

  it('persists observer events and board cards', async () => {
    const dbPath = await createStateDbPath();
    const db = await openMigratedDb(dbPath);
    const stores = createConciergeStateStores(db, {
      now: () => 10_000,
      createId: () => 'card-1',
    });

    const event = stores.events.append({
      source: 'observer',
      type: 'daemon-state',
      payload: { activeRuns: 0, paused: true },
      status: 'new',
    });
    stores.cards.upsert({
      id: 'card-1',
      status: 'needs_decision',
      title: 'Review stuck run',
      body: 'Issue 504 needs operator input',
      confirmationId: 'confirmation-1',
    });
    stores.cards.updateStatus('card-1', 'done');
    db.close();

    const reopened = await openMigratedDb(dbPath);
    const persisted = createConciergeStateStores(reopened);

    expect(persisted.events.list()).toEqual([
      {
        id: event.id,
        source: 'observer',
        type: 'daemon-state',
        payload: { activeRuns: 0, paused: true },
        status: 'new',
        createdAt: 10_000,
      },
    ]);
    expect(persisted.cards.get('card-1')).toEqual({
      id: 'card-1',
      status: 'done',
      title: 'Review stuck run',
      body: 'Issue 504 needs operator input',
      confirmationId: 'confirmation-1',
      createdAt: 10_000,
      updatedAt: 10_000,
    });
    reopened.close();
  });
});

async function createStateDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-state-stores-'));
  return join(dir, 'state.db');
}

async function openMigratedDb(path: string): Promise<ConciergeStateDatabase> {
  const db = openConciergeStateDatabase(path);
  await applyConciergeStateSchemaMigrations(db, db);
  return db;
}
