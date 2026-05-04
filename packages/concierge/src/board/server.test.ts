import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openConciergeStateDatabase } from '../memory/node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from '../memory/state-schema.js';
import { createConciergeStateStores } from '../memory/state-stores.js';
import { createConciergeBoardApp } from './server.js';

describe('concierge board app', () => {
  it('renders needs-you and in-flight cards without showing completed cards', async () => {
    const stores = await createStores();
    stores.cards.upsert({
      id: 'needs-1',
      status: 'needs_decision',
      title: 'Review daemon conflict',
      body: 'PR 505 needs a decision',
    });
    stores.cards.upsert({
      id: 'flight-1',
      status: 'in_flight',
      title: 'Running issue 504',
      body: 'Observer slice is active',
    });
    stores.cards.upsert({
      id: 'done-1',
      status: 'done',
      title: 'Done card',
      body: 'Should stay hidden',
    });

    const app = createConciergeBoardApp({ cards: stores.cards, events: stores.events, actions: fakeActions() });
    const response = await app.request('/');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('htmx.org');
    expect(html).toContain('Needs You');
    expect(html).toContain('Review daemon conflict');
    expect(html).toContain('In Flight');
    expect(html).toContain('Running issue 504');
    expect(html).not.toContain('Done card');
  });

  it('delegates pre-declared action endpoints to core without directly mutating cards', async () => {
    const stores = await createStores();
    stores.cards.upsert({
      id: 'card-1',
      status: 'needs_decision',
      title: 'Approve release',
      body: 'Release candidate ready',
    });
    const cards = {
      ...stores.cards,
      updateStatus: vi.fn(() => {
        throw new Error('board must not update card status directly');
      }),
    };
    const actions = fakeActions({
      status: 'completed',
      card: {
        id: 'card-1',
        status: 'done',
        title: 'Approve release',
        body: 'Release candidate ready',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    });

    const app = createConciergeBoardApp({ cards, events: stores.events, actions });
    const response = await app.request('/cards/card-1/done', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(actions.invoke).toHaveBeenCalledWith({ cardId: 'card-1', action: 'done' });
    expect(cards.updateStatus).not.toHaveBeenCalled();
    expect(stores.cards.get('card-1')?.status).toBe('needs_decision');
    expect(await response.text()).toContain('done');
  });

  it('serves the PWA manifest', async () => {
    const stores = await createStores();
    const app = createConciergeBoardApp({ cards: stores.cards, events: stores.events, actions: fakeActions() });
    const response = await app.request('/manifest.webmanifest');

    await expect(response.json())
      .resolves.toEqual(expect.objectContaining({
        name: 'Concierge',
        short_name: 'Concierge',
        display: 'standalone',
      }));
  });
});

function fakeActions(result = {
  status: 'completed' as const,
  card: {
    id: 'card-1',
    status: 'done',
    title: 'Done',
    body: 'Done',
    createdAt: 1_000,
    updatedAt: 2_000,
  },
}) {
  return {
    invoke: vi.fn(async () => result),
  };
}

async function createStores(): Promise<ReturnType<typeof createConciergeStateStores>> {
  const dir = await mkdtemp(join(tmpdir(), 'concierge-board-'));
  const db = openConciergeStateDatabase(join(dir, 'state.db'));
  await applyConciergeStateSchemaMigrations(db, db);
  return createConciergeStateStores(db, {
    now: () => 1_000,
  });
}
