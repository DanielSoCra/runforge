import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { ok, err, type Result } from '../lib/result.js';
import { getDashboardHtml } from './dashboard.js';
import { readResults } from './results.js';
import type { ReleaseProposalResult } from './release.js';

export interface ControlHandlers {
  getStatus: () => unknown;
  pause: () => void;
  resume: () => void | Result<void> | Promise<void | Result<void>>;
  drain: () => void;
  cancelDrain: () => void;
  retry: (issueNumber: number) => Result<void>;
  reloadRepos?: () => Promise<{ active: number }>;
  restartRemoteControl?: () => void | Promise<void>;
  scanIssues?: () => Promise<{ scanned: number }>;
  release?: () => Promise<ReleaseProposalResult>;
  submitIdea?: (submittedBy: string, description: string) => Promise<{ id: string }>;
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
      // Shape mirrors the throwaway degraded server (degraded-server.ts) so
      // both /health endpoints are uniform. The real server only binds
      // post-recovery, so these are always literal constants here.
      json(res, 200, { ok: true, degraded: false, lastConfigError: null });
    } else if (method === 'GET' && url.pathname === '/status') {
      json(res, 200, handlers.getStatus());
    } else if (method === 'POST' && url.pathname === '/pause') {
      handlers.pause();
      json(res, 200, { paused: true });
    } else if (method === 'POST' && url.pathname === '/resume') {
      Promise.resolve(handlers.resume()).then((result) => {
        if (isResult(result) && !result.ok) {
          json(res, 409, { paused: true, error: result.error.message });
          return;
        }
        json(res, 200, { paused: false });
      }).catch((e: unknown) => {
        console.error('[control-plane] POST /resume failed:', e);
        json(res, 500, { paused: true, error: 'resume failed' });
      });
    } else if (method === 'POST' && url.pathname === '/drain') {
      handlers.drain();
      json(res, 200, { draining: true });
    } else if (method === 'POST' && url.pathname === '/drain/cancel') {
      handlers.cancelDrain();
      json(res, 200, { draining: false });
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
    } else if (method === 'POST' && url.pathname === '/release') {
      if (handlers.release) {
        handlers.release().then((result) => {
          json(res, 200, result);
        }).catch((e: unknown) => {
          console.error('[control-plane] POST /release failed:', e);
          json(res, 500, { error: 'release failed' });
        });
      } else {
        json(res, 501, { error: 'not configured' });
      }
    } else if (method === 'POST' && url.pathname === '/ideas') {
      if (handlers.submitIdea) {
        const MAX_BODY = 10240; // 10KB
        let body = '';
        let oversize = false;
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > MAX_BODY) oversize = true;
        });
        req.on('error', () => { json(res, 400, { error: 'request error' }); });
        req.on('end', () => {
          if (oversize) { json(res, 413, { error: 'body too large' }); return; }
          try {
            const parsed = JSON.parse(body) as { submittedBy?: string; description?: string };
            if (!parsed.description || typeof parsed.description !== 'string') {
              json(res, 400, { error: 'description is required' });
              return;
            }
            const submittedBy = typeof parsed.submittedBy === 'string' ? parsed.submittedBy : 'operator';
            handlers.submitIdea!(submittedBy, parsed.description).then((result) => {
              json(res, 201, result);
            }).catch((e: unknown) => {
              console.error('[control-plane] POST /ideas failed:', e);
              json(res, 500, { error: 'submit failed' });
            });
          } catch {
            json(res, 400, { error: 'invalid JSON body' });
          }
        });
      } else {
        json(res, 501, { error: 'PO agent not configured' });
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

function isResult(value: unknown): value is Result<void> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
