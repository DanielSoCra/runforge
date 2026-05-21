import type { ConciergeCardRecord, ConciergeCardStore } from '../memory/state-stores.js';
import type { ToolRouter } from './router.js';

export interface BoardCardActionRequest {
  cardId: string;
  action: string;
}

export type BoardCardActionResult =
  | { status: 'completed'; card: ConciergeCardRecord }
  | { status: 'errored'; error: string };

export interface BoardCardActionService {
  invoke(request: BoardCardActionRequest): Promise<BoardCardActionResult>;
}

export interface BoardCardActionServiceOptions {
  cards: ConciergeCardStore;
  router: ToolRouter;
}

export function createBoardCardActionService(
  options: BoardCardActionServiceOptions,
): BoardCardActionService {
  const { cards, router } = options;

  return {
    async invoke(request): Promise<BoardCardActionResult> {
      const card = cards.get(request.cardId);
      if (!card) return { status: 'errored', error: `card ${request.cardId} not found` };

      if (request.action === 'done') {
        return { status: 'completed', card: cards.updateStatus(request.cardId, 'done') };
      }
      if (request.action === 'dismiss') {
        return { status: 'completed', card: cards.updateStatus(request.cardId, 'dismissed') };
      }
      if (request.action === 'snooze') {
        return { status: 'completed', card: cards.updateStatus(request.cardId, 'snoozed') };
      }
      if (request.action === 'approve' || request.action === 'deny') {
        return resolveCardConfirmation({
          action: request.action,
          card,
          cards,
          router,
        });
      }

      return { status: 'errored', error: `unknown card action ${request.action}` };
    },
  };
}

async function resolveCardConfirmation(options: {
  action: 'approve' | 'deny';
  card: ConciergeCardRecord;
  cards: ConciergeCardStore;
  router: ToolRouter;
}): Promise<BoardCardActionResult> {
  const { action, card, cards, router } = options;
  if (!card.confirmationId) {
    return {
      status: 'errored',
      error: `card ${card.id} has no confirmation to ${action}`,
    };
  }

  const result = await router.resolveConfirmation(card.confirmationId, action);
  if (result.status !== 'completed' && result.status !== 'denied') {
    return {
      status: 'errored',
      error: 'error' in result ? result.error : `confirmation ${result.status}`,
    };
  }

  return { status: 'completed', card: cards.updateStatus(card.id, 'done') };
}
