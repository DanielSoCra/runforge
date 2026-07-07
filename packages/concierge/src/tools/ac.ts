import type { ToolEntry } from './registry.js';
import { readNumberArg } from './args.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RunforgeToolOptions {
  baseUrl: string;
  requestedBy?: string;
  fetch?: FetchLike;
}

export function createRunforgeToolHandlers(
  options: RunforgeToolOptions,
): Record<'ac_status' | 'ac_pause' | 'ac_unstuck' | 'ac_run' | 'ac_merge_to_main', ToolEntry['handler']> {
  const fetchImpl = options.fetch ?? fetch;
  const requestedBy = options.requestedBy ?? 'concierge';
  const controlToken = process.env.RUNFORGE_CONTROL_TOKEN;

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const url = `${options.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {};
    if (controlToken !== undefined && controlToken !== '') {
      headers.Authorization = `Bearer ${controlToken}`;
    }
    if (init.headers !== undefined) {
      const initHeaders = init.headers as Record<string, string | string[]>;
      for (const key of Object.keys(initHeaders)) {
        const value = initHeaders[key];
        if (value !== undefined) {
          headers[key] = typeof value === 'string' ? value : value.join(', ');
        }
      }
    }
    const requestInit = Object.keys(headers).length > 0 ? { ...init, headers } : init;
    const response = await fetchImpl(url, requestInit);
    const body = await readResponseBody(response);
    if (!response.ok) {
      const message = readErrorMessage(body);
      throw new Error(`runforge request failed ${response.status}: ${message}`);
    }
    return body;
  };

  const post = (path: string): Promise<unknown> => request(path, {
    method: 'POST',
    headers: { 'X-Requested-By': requestedBy },
  });

  return {
    ac_status: async () => request('/status', { method: 'GET' }),
    ac_pause: async () => post('/pause'),
    ac_unstuck: async (args) => post(`/retry/${readNumberArg(args, 'issue')}`),
    ac_run: async (args) => post(`/retry/${readNumberArg(args, 'issue')}`),
    ac_merge_to_main: async (args) => ({
      issue: readNumberArg(args, 'issue'),
      status: 'confirmation-required',
      message: 'merge-to-main is intentionally left to the confirmed release path',
    }),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error;
    return typeof error === 'string' ? error : JSON.stringify(error);
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}
