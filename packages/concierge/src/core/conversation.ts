import { randomUUID } from 'node:crypto';

export type ConversationStatus = 'open' | 'closed';
export type ConversationRole = 'operator' | 'assistant' | 'tool';

export interface ConversationTurn {
  id: string;
  role: ConversationRole;
  text: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  status: ConversationStatus;
  turns: ConversationTurn[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStore {
  startConversation(operatorText: string): Conversation;
  appendTurn(conversationId: string, role: ConversationRole, text: string): Conversation;
  resetConversation(conversationId: string): Conversation;
  getConversation(conversationId: string): Conversation | undefined;
  listConversations(): Conversation[];
}

export interface ConversationStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export function createConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const conversations = new Map<string, Conversation>();

  const createTurn = (role: ConversationRole, text: string): ConversationTurn => ({
    id: createId(),
    role,
    text,
    createdAt: now(),
  });

  return {
    startConversation(operatorText: string): Conversation {
      const timestamp = now();
      const conversation: Conversation = {
        id: createId(),
        status: 'open',
        turns: [createTurn('operator', operatorText)],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      conversations.set(conversation.id, conversation);
      return conversation;
    },

    appendTurn(conversationId: string, role: ConversationRole, text: string): Conversation {
      const conversation = conversations.get(conversationId);
      if (!conversation) throw new Error(`conversation ${conversationId} not found`);
      if (conversation.status !== 'open') throw new Error(`conversation ${conversationId} is closed`);
      const updated: Conversation = {
        ...conversation,
        turns: [...conversation.turns, createTurn(role, text)],
        updatedAt: now(),
      };
      conversations.set(conversationId, updated);
      return updated;
    },

    resetConversation(conversationId: string): Conversation {
      const conversation = conversations.get(conversationId);
      if (!conversation) throw new Error(`conversation ${conversationId} not found`);
      const updated: Conversation = {
        ...conversation,
        status: 'closed',
        updatedAt: now(),
      };
      conversations.set(conversationId, updated);
      return updated;
    },

    getConversation(conversationId: string): Conversation | undefined {
      return conversations.get(conversationId);
    },

    listConversations(): Conversation[] {
      return [...conversations.values()];
    },
  };
}
