import type { ConfirmationStore } from '../confirmation/state-machine.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createAuditLog, type AuditLog } from './audit-log.js';
import { createConversationStore, type Conversation, type ConversationStore } from './conversation.js';
import { createToolRouter, type ToolDispatchResult, type ToolRouter } from './router.js';

export type PlannerIntent =
  | { kind: 'tool'; toolName: string; args: unknown }
  | { kind: 'procedure'; name: string; steps: Array<{ toolName: string; args: unknown }> }
  | { kind: 'none' };

export type ConciergePlanner = (input: {
  text: string;
  conversation: Conversation;
  registry: ToolRegistry;
}) => Promise<PlannerIntent>;

export interface ShortcutProposal {
  name: string;
  steps: Array<{ toolName: string; args: unknown }>;
  status: 'pending' | 'approved' | 'denied';
  count: number;
}

export interface HandleMessageInput {
  conversationId?: string;
  text: string;
}

export interface HandleMessageResult {
  conversationId: string;
  conversation: Conversation;
  reply: string;
  toolResult?: ToolDispatchResult;
}

export interface ConciergeCore {
  handleOperatorMessage(input: HandleMessageInput): Promise<HandleMessageResult>;
  listShortcutProposals(): ShortcutProposal[];
  approveShortcut(name: string): ShortcutProposal;
  denyShortcut(name: string): ShortcutProposal;
  conversations: ConversationStore;
  router: ToolRouter;
  auditLog: AuditLog;
}

export interface ConciergeCoreOptions {
  registry: ToolRegistry;
  confirmations: ConfirmationStore;
  planner: ConciergePlanner;
  shortcutThreshold?: number;
  conversations?: ConversationStore;
  auditLog?: AuditLog;
}

export function createConciergeCore(options: ConciergeCoreOptions): ConciergeCore {
  const conversations = options.conversations ?? createConversationStore();
  const auditLog = options.auditLog ?? createAuditLog();
  const router = createToolRouter({
    registry: options.registry,
    confirmations: options.confirmations,
    auditLog,
  });
  const shortcutThreshold = options.shortcutThreshold ?? 3;
  const procedureCounts = new Map<string, number>();
  const proposals = new Map<string, ShortcutProposal>();

  const appendAssistant = (conversationId: string, reply: string): Conversation => {
    return conversations.appendTurn(conversationId, 'assistant', reply);
  };

  const formatToolResult = (toolName: string, result: ToolDispatchResult): string => {
    switch (result.status) {
      case 'completed':
        return `${toolName} completed: ${JSON.stringify(result.result)}`;
      case 'pending_confirmation':
        return result.message;
      case 'unavailable':
        return `Capability unavailable: ${result.error}`;
      case 'invalid_args':
        return `Capability arguments invalid: ${result.errors.join('; ')}`;
      case 'denied':
      case 'expired':
      case 'errored':
        return result.error;
    }
  };

  const core: ConciergeCore = {
    conversations,
    router,
    auditLog,

    async handleOperatorMessage(input): Promise<HandleMessageResult> {
      let conversation: Conversation;
      if (input.conversationId && conversations.getConversation(input.conversationId)?.status === 'open') {
        conversation = conversations.appendTurn(input.conversationId, 'operator', input.text);
      } else {
        conversation = conversations.startConversation(input.text);
      }

      if (isReset(input.text)) {
        conversations.resetConversation(conversation.id);
        const fresh = conversations.startConversation('fresh start');
        const reply = 'Conversation reset. Starting fresh.';
        const updated = appendAssistant(fresh.id, reply);
        return { conversationId: fresh.id, conversation: updated, reply };
      }

      const intent = await options.planner({
        text: input.text,
        conversation,
        registry: options.registry,
      });

      if (intent.kind === 'none') {
        const reply = 'I cannot do that with the currently available concierge capabilities.';
        const updated = appendAssistant(conversation.id, reply);
        return { conversationId: conversation.id, conversation: updated, reply };
      }

      if (intent.kind === 'tool') {
        const toolResult = await router.dispatch({
          conversationId: conversation.id,
          toolName: intent.toolName,
          args: intent.args,
        });
        const reply = formatToolResult(intent.toolName, toolResult);
        const updated = appendAssistant(conversation.id, reply);
        return { conversationId: conversation.id, conversation: updated, reply, toolResult };
      }

      const results: string[] = [];
      for (const step of intent.steps) {
        const toolResult = await router.dispatch({
          conversationId: conversation.id,
          toolName: step.toolName,
          args: step.args,
        });
        results.push(formatToolResult(step.toolName, toolResult));
      }

      const count = (procedureCounts.get(intent.name) ?? 0) + 1;
      procedureCounts.set(intent.name, count);
      let reply = results.join('\n');
      if (count >= shortcutThreshold && !proposals.has(intent.name)) {
        proposals.set(intent.name, {
          name: intent.name,
          steps: intent.steps,
          status: 'pending',
          count,
        });
        reply = `${reply}\nSave recurring procedure ${intent.name}?`;
      }

      const updated = appendAssistant(conversation.id, reply);
      return { conversationId: conversation.id, conversation: updated, reply };
    },

    listShortcutProposals(): ShortcutProposal[] {
      return [...proposals.values()];
    },

    approveShortcut(name: string): ShortcutProposal {
      return updateShortcut(name, 'approved');
    },

    denyShortcut(name: string): ShortcutProposal {
      return updateShortcut(name, 'denied');
    },
  };

  const updateShortcut = (name: string, status: ShortcutProposal['status']): ShortcutProposal => {
    const proposal = proposals.get(name);
    if (!proposal) throw new Error(`shortcut proposal ${name} not found`);
    const updated: ShortcutProposal = { ...proposal, status };
    proposals.set(name, updated);
    return updated;
  };

  return core;
}

function isReset(text: string): boolean {
  return /\b(reset|fresh start|start over)\b/i.test(text);
}
