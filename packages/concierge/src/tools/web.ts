import type { ToolEntry } from './registry.js';
import { readStringArg } from './args.js';
import type { FetchLike } from './ac.js';

export interface WebToolOptions {
  fetch?: FetchLike;
  maxBytes?: number;
}

export function createWebToolHandlers(options: WebToolOptions = {}): Record<'web_fetch', ToolEntry['handler']> {
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 20_000;

  return {
    web_fetch: async (args) => {
      const url = readStringArg(args, 'url');
      const response = await fetchImpl(url, { method: 'GET' });
      const fullText = await response.text();
      const text = fullText.slice(0, maxBytes);
      return {
        url,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        text,
        truncated: fullText.length > text.length,
      };
    },
  };
}
