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
  restartRemoteControl?: () => void | Promise<void>;
  scanIssues?: () => Promise<{ scanned: number }>;
  stateDir?: string;
}

export function createControlServer(
  port: number,
  handlers: ControlHandlers,
  host: string = '127.0.0.1',
): { server: Server; start: () => Promise<Result<void>> } {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    // CSRF protection: require a custom header on POST requests.
    // Browsers enforce CORS preflight for requests with custom headers,
    // and since this server sets no Access-Control-Allow-* headers,
    // cross-origin POSTs from malicious pages are blocked.
    if (method === 'POST' && !req.headers['x-requested-by']) {
      json(res, 403, { error: 'Missing X-Requested-By header' });
      return;
    }

    if (method === 'GET' && url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
    } else if (method === 'GET' && url.pathname === '/api/runs') {
      readResults(handlers.stateDir).then((runs) => {
        json(res, 200, runs);
      }).catch((e: unknown) => {
        console.error('[control-plane] GET /api/runs failed:', e);
        json(res, 500, { error: 'read failed' });
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
    } else if (method === 'POST' && url.pathname === '/repos/reload') {
      if (handlers.reloadRepos) {
        handlers.reloadRepos().then((result) => {
          json(res, 200, { reloaded: true, active: result.active });
        }).catch((e: unknown) => {
          console.error('[control-plane] POST /repos/reload failed:', e);
          json(res, 500, { error: 'reload failed' });
        });
      } else {
        json(res, 200, { reloaded: false, active: 0 });
      }
    } else if (method === 'POST' && url.pathname === '/remote-control/restart') {
      if (handlers.restartRemoteControl) {
        Promise.resolve(handlers.restartRemoteControl()).then(() => {
          json(res, 200, { restarted: true });
        }).catch((e: unknown) => {
          console.error('[control-plane] POST /remote-control/restart failed:', e);
          json(res, 500, { error: 'restart failed' });
        });
      } else {
        json(res, 501, { error: 'not configured' });
      }
    } else if (method === 'POST' && url.pathname === '/issues/scan') {
      if (handlers.scanIssues) {
        handlers.scanIssues().then((result) => {
          json(res, 200, result);
        }).catch((e: unknown) => {
          console.error('[control-plane] POST /issues/scan failed:', e);
          json(res, 500, { error: 'scan failed' });
        });
      } else {
        json(res, 501, { error: 'not configured' });
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
            resolve(err(new Error(`Instance lock failed — port ${port} in use (another instance is running)`)));
          } else {
            resolve(err(e));
          }
        });
        // exclusive: true prevents port sharing; SO_REUSEADDR is set by default (libuv)
        // allowing immediate rebind after crash without TIME_WAIT delay
        server.listen({ port, host, exclusive: true }, () => {
          console.log(`[daemon] Instance lock acquired (port ${port})`);
          resolve(ok(undefined));
        });
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
