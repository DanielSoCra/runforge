import { readStringArg } from './args.js';
import type { ToolEntry } from './registry.js';

export interface SlackClient {
  postMessage(input: { channel: string; text: string }): Promise<unknown>;
}

export interface SlackToolOptions {
  operatorUserId: string;
  client: SlackClient;
}

export function createSlackToolHandlers(
  options: SlackToolOptions,
): Record<'slack_send_dm' | 'slack_send_channel', ToolEntry['handler']> {
  return {
    slack_send_dm: async (args) => options.client.postMessage({
      channel: options.operatorUserId,
      text: readStringArg(args, 'text'),
    }),
    slack_send_channel: async (args) => options.client.postMessage({
      channel: readStringArg(args, 'channel'),
      text: readStringArg(args, 'text'),
    }),
  };
}
