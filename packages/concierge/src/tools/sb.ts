import { createVaultPolicy } from '../memory/vault.js';
import { readStringArg } from './args.js';
import type { ToolEntry } from './registry.js';

export interface SecondBrainClient {
  read(path: string): Promise<unknown>;
  search(query: string): Promise<unknown>;
  appendInbox(input: { slug: string; body: string }): Promise<unknown>;
  writeDecision(path: string): Promise<unknown>;
  writeClient(path: string): Promise<unknown>;
}

export interface SecondBrainToolOptions {
  vaultPath: string;
  allowList: string[];
  confirmationRequired: string[];
  client: SecondBrainClient;
}

export function createSecondBrainToolHandlers(
  options: SecondBrainToolOptions,
): Record<
  'sb_read' | 'sb_search' | 'sb_append_inbox' | 'sb_write_decision' | 'sb_write_client',
  ToolEntry['handler']
> {
  const policy = createVaultPolicy(options);

  const assertVaultAccess = (path: string, operation: 'read' | 'write', allowConfirm = false): void => {
    const decision = policy.authorize(path, operation);
    if (decision.decision === 'allow') return;
    if (allowConfirm && decision.decision === 'confirm') return;
    throw new Error(decision.reason);
  };

  return {
    sb_read: async (args) => {
      const path = readStringArg(args, 'path');
      assertVaultAccess(path, 'read');
      return options.client.read(path);
    },
    sb_search: async (args) => options.client.search(readStringArg(args, 'query')),
    sb_append_inbox: async (args) => options.client.appendInbox({
      slug: readStringArg(args, 'slug'),
      body: readStringArg(args, 'body'),
    }),
    sb_write_decision: async (args) => {
      const path = readStringArg(args, 'path');
      assertVaultAccess(path, 'write');
      return options.client.writeDecision(path);
    },
    sb_write_client: async (args) => {
      const path = readStringArg(args, 'path');
      assertVaultAccess(path, 'write', true);
      return options.client.writeClient(path);
    },
  };
}
