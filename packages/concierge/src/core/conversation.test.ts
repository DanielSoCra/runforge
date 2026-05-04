import { describe, expect, it } from 'vitest';
import { createConversationStore } from './conversation.js';

describe('conversation store', () => {
  it('starts a new conversation for a top-level operator message', () => {
    const store = createConversationStore();

    const conversation = store.startConversation('hello');

    expect(conversation.status).toBe('open');
    expect(conversation.turns).toEqual([
      expect.objectContaining({ role: 'operator', text: 'hello' }),
    ]);
  });

  it('continues an existing conversation with access to prior turns', () => {
    const store = createConversationStore();
    const conversation = store.startConversation('first');

    const updated = store.appendTurn(conversation.id, 'assistant', 'second');

    expect(updated.turns.map((turn) => turn.text)).toEqual(['first', 'second']);
  });

  it('closes a conversation on reset and starts fresh next time', () => {
    const store = createConversationStore();
    const conversation = store.startConversation('before reset');

    store.resetConversation(conversation.id);
    const next = store.startConversation('after reset');

    expect(store.getConversation(conversation.id)?.status).toBe('closed');
    expect(next.id).not.toBe(conversation.id);
    expect(next.turns.map((turn) => turn.text)).toEqual(['after reset']);
  });
});
