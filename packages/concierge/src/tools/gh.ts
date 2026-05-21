import { readNumberArg, readStringArg } from './args.js';
import type { ToolEntry } from './registry.js';

export interface GitHubClient {
  search(query: string): Promise<unknown>;
  comment(input: { repo: string; number: number; body: string }): Promise<unknown>;
}

export function createGitHubToolHandlers(
  options: { client: GitHubClient },
): Record<'gh_search' | 'gh_comment', ToolEntry['handler']> {
  return {
    gh_search: async (args) => options.client.search(readStringArg(args, 'query')),
    gh_comment: async (args) => options.client.comment({
      repo: readStringArg(args, 'repo'),
      number: readNumberArg(args, 'number'),
      body: readStringArg(args, 'body'),
    }),
  };
}
