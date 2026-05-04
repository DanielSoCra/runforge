import { describe, expect, it, vi } from 'vitest';
import { createBoardCardActionService } from './board-actions.js';
import type { ToolRouter } from './router.js';
import type { ConciergeCardRecord, ConciergeCardStore } from '../memory/state-stores.js';

const card: ConciergeCardRecord = {
  id: 'card-1',
  status: 'needs_decision',
  title: 'Approve release',
  body: 'Release candidate ready',
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe('board card actions', () => {
  it('updates card status from core-owned action handling', async () => {
    const cards = fakeCardStore(card);
    const service = createBoardCardActionService({ cards, router: fakeRouter() });

    const result = await service.invoke({ cardId: 'card-1', action: 'dismiss' });

    expect(result).toEqual({
      status: 'completed',
      card: { ...card, status: 'dismissed' },
    });
    expect(cards.updateStatus).toHaveBeenCalledWith('card-1', 'dismissed');
  });

  it('resolves confirmation actions through the tool router before clearing the card', async () => {
    const cards = fakeCardStore({ ...card, confirmationId: 'conf-1' });
    const router = fakeRouter();
    const service = createBoardCardActionService({ cards, router });

    const result = await service.invoke({ cardId: 'card-1', action: 'approve' });

    expect(router.resolveConfirmation).toHaveBeenCalledWith('conf-1', 'approve');
    expect(result.status).toBe('completed');
    expect(cards.updateStatus).toHaveBeenCalledWith('card-1', 'done');
  });

  it('returns an error when a confirmation action has no confirmation id', async () => {
    const service = createBoardCardActionService({ cards: fakeCardStore(card), router: fakeRouter() });

    await expect(service.invoke({ cardId: 'card-1', action: 'approve' }))
      .resolves.toEqual({
        status: 'errored',
        error: 'card card-1 has no confirmation to approve',
      });
  });
});

function fakeCardStore(initial: ConciergeCardRecord): ConciergeCardStore {
  const current = { ...initial };
  return {
    upsert: vi.fn(),
    updateStatus: vi.fn((id: string, status: string) => {
      current.status = status;
      return { ...current };
    }),
    get: vi.fn((id: string) => id === current.id ? { ...current } : undefined),
    list: vi.fn(() => [{ ...current }]),
  };
}

function fakeRouter(): ToolRouter {
  return {
    dispatch: vi.fn(),
    resolveConfirmation: vi.fn(async () => ({ status: 'completed' as const, result: { ok: true } })),
  };
}
