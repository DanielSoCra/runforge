import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { ok, err, type Result } from '../lib/result.js';
import { getDashboardHtml } from './dashboard.js';
import { readResults } from './results.js';

export interface ControlHandlers {
  getStatus: () => unknown;
  pause: () => void;
  resume: () => void;
  retry: (issueNumber: number) => Result<void>;
  reloadRepos?: () => Promise<{ active: number }>;
  restartRemoteControl?: () => Promise<void>;
  stateDir?: string;
}

export function createControlServer(
  port: number,
  handlers: ControlHandlers,
): { server: Server; start: () => Promise<Result<void>> } {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
    } else if (method === 'GET' && url.pathname === '/api/runs') {
      readResults(handlers.stateDir).then((runs) => {
        json(res, 200, runs);
      }).catch(() => {
        json(res, 200, []);
      });
    } else if (method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true });
    } else if (method === 'GET' && url.pathname === '/status') {
      json(res, 200, handlers.getStatus());
    } else if (method === 'POST' && url.pathname === '/pause') {
      handlers.pause();
      json(res, 200, { paused: true });
    } else if (method === 'POST' && url.pathname === '/resume') {
      handlers.resume();
      json(res, 200, { paused: false });
    } else if (method === 'POST' && url.pathname === '/remote-control/restart') {
      if (handlers.restartRemoteControl) {
        handlers.restartRemoteControl().then(() => {
          json(res, 200, { restarting: true });
        }).catch(() => {
          json(res, 500, { error: 'restart failed' });
        });
      } else {
        json(res, 200, { restarting: false });
      }
    } else if (method === 'POST' && url.pathname === '/repos/reload') {
      if (handlers.reloadRepos) {
        handlers.reloadRepos().then((result) => {
          json(res, 200, { reloaded: true, active: result.active });
        }).catch(() => {
          json(res, 500, { error: 'reload failed' });
        });
      } else {
        json(res, 200, { reloaded: false, active: 0 });
      }
    } else if (method === 'POST' && url.pathname.startsWith('/retry/')) {
      const issue = Number(url.pathname.split('/')[2]);
      if (isNaN(issue)) {
        json(res, 400, { error: 'invalid issue number' });
        return;
      }
      const result = handlers.retry(issue);
      json(
        res,
        result.ok ? 200 : 404,
        result.ok ? { retrying: issue } : { error: (result as { ok: false; error: Error }).error.message },
      );
    } else {
      json(res, 404, { error: 'not found' });
    }
  });

  return {
    server,
    start: () =>
      new Promise((resolve) => {
        server.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EADDRINUSE') {
            resolve(err(new Error(`Port ${port} in use — another instance is running`)));
          } else {
            resolve(err(e));
          }
        });
        server.listen(port, '127.0.0.1', () => resolve(ok(undefined)));
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
