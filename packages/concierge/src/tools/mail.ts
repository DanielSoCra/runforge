import { readStringArg } from './args.js';
import type { ToolEntry } from './registry.js';

export interface MailClient {
  draft(input: { to: string; subject: string; body: string }): Promise<unknown>;
  send(draftId: string): Promise<unknown>;
}

export function createMailToolHandlers(
  options: { client: MailClient },
): Record<'mail_draft' | 'mail_send', ToolEntry['handler']> {
  return {
    mail_draft: async (args) => options.client.draft({
      to: readStringArg(args, 'to'),
      subject: readStringArg(args, 'subject'),
      body: readStringArg(args, 'body'),
    }),
    mail_send: async (args) => options.client.send(readStringArg(args, 'draftId')),
  };
}
