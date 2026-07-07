import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http';

import { checkAuthorization, assertBindAllowed } from './control-auth.js';

import type { ConfigFetchError } from '../data/config-reader.js';
import { err, ok, type Result } from '../lib/result.js';

export interface DegradedState {
  lastConfigError: ConfigFetchError | null;
}

export interface DegradedServerHandle {
  close(): Promise<void>;
}

/**
 * A minimal, throwaway control server bound on the control port while the
 * daemon is starting up but cannot yet reach the Data Service. It answers ONLY
 * `/health` + `/status` (both `degraded: true`); everything else is 503. It
 * holds the control port (the port IS the daemon's instance lock) until the
 * real server takes over after config has loaded.
 */
export function createDegradedServer(
  port: number,
  host: string,
  getState: () => DegradedState,
): { start: () => Promise<Result<void>>; handle: DegradedServerHandle } {
  assertBindAllowed(host, process.env.RUNFORGE_CONTROL_TOKEN);

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const method = req.method ?? 'GET';
      const { lastConfigError } = getState();

      if (method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, degraded: true, lastConfigError });
      } else if (method === 'GET' && url.pathname === '/status') {
        const controlToken = process.env.RUNFORGE_CONTROL_TOKEN;
        const tokenConfigured = typeof controlToken === 'string' && controlToken !== '';
        if (tokenConfigured) {
          const auth = checkAuthorization(req.headers.authorization, controlToken);
          if (!auth.ok) {
            json(res, auth.status, { error: auth.error });
            return;
          }
        }
        json(res, 200, {
          degraded: true,
          lastConfigError,
          uptime: process.uptime(),
        });
      } else {
        json(res, 503, { error: 'daemon starting (degraded)' });
      }
    },
  );

  let closed = false;

  const handle: DegradedServerHandle = {
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        // server.close() errors only if the server was never listening; we
        // resolve regardless so cleanup paths can call this unconditionally.
        server.close(() => resolve());
      }),
  };

  return {
    start: () =>
      new Promise<Result<void>>((resolve) => {
        server.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE') {
            resolve(
              err(
                new Error(
                  `Instance lock failed — port ${port} in use (another instance is running)`,
                ),
              ),
            );
          } else {
            resolve(err(e));
          }
        });
        server.listen({ port, host, exclusive: true }, () => {
          resolve(ok(undefined));
        });
      }),
    handle,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
