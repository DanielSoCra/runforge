import { createServer as createHttpServer, type Server } from 'node:http';
import { normalizeSlackEvent, parseConfirmationActionId, verifySlackSignature } from './adapter.js';
import type { SlackRuntimeHandlers, SlackRuntimeReceiver } from '../core/runtime.js';

export interface SlackHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface SlackHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandleSlackHttpRequestOptions {
  request: SlackHttpRequest;
  handlers: SlackRuntimeHandlers;
  signingSecret: string;
  now?: () => number;
}

export interface SlackHttpReceiverOptions {
  signingSecret: string;
  host?: string;
  port?: number;
  path?: string;
  now?: () => number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3848;
const DEFAULT_PATH = '/slack/events';

export async function handleSlackHttpRequest(
  options: HandleSlackHttpRequestOptions,
): Promise<SlackHttpResponse> {
  const { request, handlers, signingSecret } = options;
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' });
  }

  const timestamp = Number(readHeader(request.headers, 'x-slack-request-timestamp'));
  const signature = readHeader(request.headers, 'x-slack-signature');
  if (!Number.isFinite(timestamp) || !signature || !verifySlackSignature({
    signingSecret,
    timestamp,
    rawBody: request.body,
    signature,
    now: options.now,
  })) {
    return jsonResponse(401, { error: 'invalid slack signature' });
  }

  const payload = parseSlackPayload(request);
  if (payload instanceof Error) {
    return jsonResponse(400, { error: payload.message });
  }

  if (payload.type === 'url_verification') {
    const challenge = typeof payload.challenge === 'string' ? payload.challenge : '';
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: challenge,
    };
  }

  if (payload.type === 'block_actions') {
    const action = parseConfirmationActionId(readFirstActionId(payload));
    if (action) await handlers.confirmation(action);
    return jsonResponse(200, { ok: true });
  }

  const message = normalizeSlackEvent(payload);
  if (message) await handlers.message(message);
  return jsonResponse(200, { ok: true });
}

export function createSlackHttpReceiver(options: SlackHttpReceiverOptions): SlackRuntimeReceiver {
  let server: Server | undefined;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const path = options.path ?? DEFAULT_PATH;

  return {
    async start(handlers): Promise<void> {
      if (server) return;
      server = createHttpServer(async (request, response) => {
        const body = await readRequestBody(request);
        const requestPath = new URL(request.url ?? '/', `http://${host}`).pathname;
        const result = requestPath === path
          ? await handleSlackHttpRequest({
            request: {
              method: request.method ?? 'GET',
              path: requestPath,
              headers: request.headers,
              body,
            },
            handlers,
            signingSecret: options.signingSecret,
            now: options.now,
          })
          : jsonResponse(404, { error: 'not found' });
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      });

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, host, () => {
          server?.off('error', reject);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (!server) return;
      const closing = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function parseSlackPayload(request: SlackHttpRequest): Record<string, unknown> | Error {
  try {
    const contentType = readHeader(request.headers, 'content-type');
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const encodedPayload = new URLSearchParams(request.body).get('payload');
      if (!encodedPayload) return new Error('missing slack payload');
      return JSON.parse(encodedPayload) as Record<string, unknown>;
    }
    return JSON.parse(request.body) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`invalid slack payload: ${message}`);
  }
}

function readFirstActionId(payload: Record<string, unknown>): string {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const first = actions[0];
  if (typeof first !== 'object' || first === null) return '';
  const actionId = (first as Record<string, unknown>).action_id;
  return typeof actionId === 'string' ? actionId : '';
}

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function jsonResponse(status: number, body: Record<string, unknown>): SlackHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
