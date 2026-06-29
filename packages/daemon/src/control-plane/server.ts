import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { ok, err, type Result } from '../lib/result.js';
import { getDashboardHtml } from './dashboard.js';
import { readResults } from './results.js';
import type { ReleaseProposalResult } from './release.js';
import type { ListRankedArgs, ListFilters, RankedListItem, DetailView } from '@auto-claude/decision-index';
import type { HandlerResult, ErrorBody, AnswerBody, RevealBody } from './decision-api.js';
import type { RiskClass, AutonomyLevel, WideningOutcome } from './deployment-registry/types.js';

export interface ControlHandlers {
  getStatus: () => unknown;
  /**
   * Minimal liveness/health signal (first-use PR1). Returns the governed
   * decision-index health only — `ok:false` ⇒ HTTP 503. The full /health mapping
   * (stuck / watchdog / pauseReason) lands in PR2 (T2.6). Absent ⇒ the server
   * falls back to the legacy always-ok response.
   */
  getHealth?: () => { ok: boolean; degraded: boolean; reason: string | null };
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
  startInteractivePoSession?: () => Promise<HandlerResult<unknown>>;
  listPendingDecisions?: (
    query: ListRankedArgs,
  ) => Promise<HandlerResult<RankedListItem[] | ErrorBody>>;
  getDecisionDetail?: (id: string) => Promise<HandlerResult<DetailView | ErrorBody>>;
  revealProtected?: (
    id: string,
    body: RevealBody,
    actor: string,
  ) => Promise<HandlerResult<{ field: string; value: string } | ErrorBody>>;
  answerDecision?: (
    id: string,
    body: AnswerBody,
  ) => Promise<HandlerResult<{ answered: true; chosen_option: string } | ErrorBody>>;
  widenAutonomy?: (
    id: string,
    grant: { riskClass: RiskClass; target: AutonomyLevel; lane?: string; operator: string },
  ) => WideningOutcome;
  stateDir?: string;
}

export function createControlServer(
  port: number,
  handlers: ControlHandlers,
  host: string = '127.0.0.1',
): { server: Server; start: () => Promise<Result<void>> } {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      // B4 truthful /health (first-use PR2, T2.6). getHealth() returns the full
      // evaluation; this maps it onto the HTTP status code:
      //   - ok:false              → 503 (unsafe / no progress: stuck, watchdog
      //                              stall, governed index down, safety pause, …)
      //   - ok:true, degraded:true → 200 with degraded:true (intentional/transient:
      //                              manual pause, draining, governed-without-channel,
      //                              startup-degraded, transient alert failure)
      //   - ok:true, degraded:false → 200 ok (normal)
      // A non-governed/healthy daemon keeps the legacy 200-ok shape byte-for-byte.
      // The degraded-boot server (degraded-server.ts) is unchanged.
      const health = handlers.getHealth?.();
      if (health && !health.ok) {
        json(res, 503, {
          ok: false,
          degraded: true,
          reason: health.reason,
          lastConfigError: null,
        });
      } else if (health && health.degraded) {
        json(res, 200, {
          ok: true,
          degraded: true,
          reason: health.reason,
          lastConfigError: null,
        });
      } else {
        json(res, 200, { ok: true, degraded: false, lastConfigError: null });
      }
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
    } else if (method === 'POST' && url.pathname === '/po/interactive-session') {
      if (handlers.startInteractivePoSession) {
        handlers.startInteractivePoSession().then((result) => {
          json(res, result.status, result.body);
        }).catch((e: unknown) => {
          console.error('[control-plane] POST /po/interactive-session failed:', e);
          json(res, 500, { error: 'session failed' });
        });
      } else {
        json(res, 501, { error: 'interactive PO sessions not configured' });
      }
    } else if (method === 'GET' && url.pathname === '/decisions/pending') {
      if (handlers.listPendingDecisions) {
        try {
          const query = parseListRankedArgs(url.searchParams);
          const result = await handlers.listPendingDecisions(query);
          json(res, result.status, result.body);
        } catch (e: unknown) {
          console.error('[control-plane] GET /decisions/pending failed:', e);
          json(res, 503, { error: 'decision index unavailable' });
        }
      } else {
        json(res, 501, { error: 'decision index not configured' });
      }
    } else if (method === 'GET' && url.pathname.startsWith('/decisions/')) {
      if (handlers.getDecisionDetail) {
        // Decision ids contain colons (e.g. `issue-42:l2-gate:1`); a client encodes
        // them into the path, and URL.pathname preserves the escapes — decode before
        // lookup or a valid decision 404s. A malformed escape (e.g. a lone `%`) is a
        // bad id → 404, never a 500.
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/decisions/'.length));
        } catch {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (id.length === 0) {
          json(res, 404, { error: 'not found' });
          return;
        }
        try {
          const result = await handlers.getDecisionDetail(id);
          json(res, result.status, result.body);
        } catch (e: unknown) {
          console.error('[control-plane] GET /decisions/:id failed:', e);
          json(res, 503, { error: 'decision index unavailable' });
        }
      } else {
        json(res, 501, { error: 'decision index not configured' });
      }
    } else if (
      method === 'POST' &&
      url.pathname.startsWith('/decisions/') &&
      url.pathname.endsWith('/answer')
    ) {
      if (handlers.answerDecision) {
        // Path is `/decisions/<id>/answer`; the id contains colons (e.g.
        // `issue-42:l2-gate:1`), URL-encoded by the client. Strip the prefix and
        // the `/answer` suffix, then decode — a malformed escape or empty id is a
        // bad id → 404, never a 500 (mirrors the GET detail decode).
        const encoded = url.pathname.slice('/decisions/'.length, -'/answer'.length);
        let id: string;
        try {
          id = decodeURIComponent(encoded);
        } catch {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (id.length === 0) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const MAX_BODY = 10240; // 10KB
        let rawBody = '';
        let oversize = false;
        req.on('data', (chunk: Buffer) => {
          rawBody += chunk.toString();
          if (rawBody.length > MAX_BODY) oversize = true;
        });
        req.on('error', () => { json(res, 400, { error: 'request error' }); });
        req.on('end', () => {
          if (oversize) { json(res, 413, { error: 'body too large' }); return; }
          let parsed: AnswerBody;
          try {
            parsed = JSON.parse(rawBody) as AnswerBody;
          } catch {
            json(res, 400, { error: 'invalid JSON body' });
            return;
          }
          handlers.answerDecision!(id, parsed).then((result) => {
            json(res, result.status, result.body);
          }).catch((e: unknown) => {
            console.error('[control-plane] POST /decisions/:id/answer failed:', e);
            json(res, 503, { error: 'decision index unavailable' });
          });
        });
      } else {
        json(res, 501, { error: 'decision index not configured' });
      }
    } else if (
      method === 'POST' &&
      url.pathname.startsWith('/decisions/') &&
      url.pathname.endsWith('/reveal')
    ) {
      if (handlers.revealProtected) {
        // Path is `/decisions/<id>/reveal`; decode the id (mirrors detail/answer).
        const encoded = url.pathname.slice('/decisions/'.length, -'/reveal'.length);
        let id: string;
        try {
          id = decodeURIComponent(encoded);
        } catch {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (id.length === 0) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const MAX_BODY = 10240; // 10KB
        let rawBody = '';
        let bytes = 0;
        let responded = false;
        const respond = (status: number, body: unknown): void => {
          if (responded) return;
          responded = true;
          json(res, status, body);
        };
        req.on('data', (chunk: Buffer) => {
          if (responded) return;
          bytes += chunk.length;
          // Enforce the cap BEFORE buffering, so an oversized body is never fully
          // read into memory; stop reading the request once we respond 413.
          if (bytes > MAX_BODY) {
            respond(413, { error: 'body too large' });
            req.destroy();
            return;
          }
          rawBody += chunk.toString();
        });
        req.on('error', () => { respond(400, { error: 'request error' }); });
        req.on('end', async () => {
          if (responded) return;
          let parsed: RevealBody;
          try {
            parsed = JSON.parse(rawBody) as RevealBody;
          } catch {
            respond(400, { error: 'invalid JSON body' });
            return;
          }
          // The daemon itself is not role-aware; the dashboard enforces admin-only.
          // We still need an actor for the audit log. The dashboard forwards the
          // operator's identity in the body; fall back to the CSRF header origin.
          const actorHeader = Array.isArray(req.headers['x-requested-by'])
            ? req.headers['x-requested-by'][0]
            : req.headers['x-requested-by'];
          const actor =
            typeof parsed === 'object' && parsed !== null && 'actor' in parsed &&
            typeof (parsed as { actor?: unknown }).actor === 'string'
              ? (parsed as { actor: string }).actor
              : (actorHeader ?? 'daemon');
          try {
            const result = await handlers.revealProtected!(id, parsed, actor);
            respond(result.status, result.body);
          } catch (e: unknown) {
            console.error('[control-plane] POST /decisions/:id/reveal failed:', e);
            respond(503, { error: 'decision index unavailable' });
          }
        });
      } else {
        json(res, 501, { error: 'decision index not configured' });
      }
    } else if (
      method === 'POST' &&
      url.pathname.startsWith('/deployments/') &&
      url.pathname.endsWith('/widen')
    ) {
      if (handlers.widenAutonomy) {
        // Path is `/deployments/<id>/widen`; the id is URL-encoded by the client.
        const encoded = url.pathname.slice('/deployments/'.length, -'/widen'.length);
        let id: string;
        try {
          id = decodeURIComponent(encoded);
        } catch {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (id.length === 0) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const MAX_BODY = 10240; // 10KB
        let rawBody = '';
        let bytes = 0;
        let responded = false;
        const respond = (status: number, body: unknown): void => {
          if (responded) return;
          responded = true;
          json(res, status, body);
        };
        req.on('data', (chunk: Buffer) => {
          if (responded) return;
          bytes += chunk.length;
          // Enforce the cap BEFORE buffering, so an oversized body is never fully
          // read into memory; stop reading the request once we respond 413.
          if (bytes > MAX_BODY) {
            respond(413, { error: 'body too large' });
            req.destroy();
            return;
          }
          rawBody += chunk.toString();
        });
        req.on('error', () => { respond(400, { error: 'request error' }); });
        req.on('end', () => {
          if (responded) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            respond(400, { error: 'invalid JSON body' });
            return;
          }
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
          ) {
            respond(400, { error: 'invalid body' });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const riskClass = body.riskClass;
          const target = body.target;
          const lane = body.lane;
          const operator = body.operator;
          if (typeof riskClass !== 'string' || riskClass.length === 0) {
            respond(400, { error: 'riskClass is required' });
            return;
          }
          if (target !== 'human-gated' && target !== 'widened') {
            respond(400, { error: 'target must be human-gated or widened' });
            return;
          }
          if (typeof operator !== 'string' || operator.length === 0) {
            respond(400, { error: 'operator is required' });
            return;
          }
          if (lane !== undefined && typeof lane !== 'string') {
            respond(400, { error: 'lane must be a string' });
            return;
          }
          let outcome;
          try {
            outcome = handlers.widenAutonomy!(id, {
              riskClass: riskClass as RiskClass,
              target: target as AutonomyLevel,
              lane,
              operator,
            });
          } catch (e) {
            // A widen that throws (e.g. the durable autonomy write failed) must not
            // escape as a raw 500: persistence-first means in-memory stays unchanged,
            // so surface a controlled 503 and let the Operator retry.
            console.error('[control-plane] POST /deployments/:id/widen failed:', e);
            respond(503, { error: 'autonomy widening could not be persisted' });
            return;
          }
          if (!outcome.ok) {
            // An unknown deployment is surfaced as a 404; any other rejected
            // widening (unknown class, unauthorized, unknown lane) is a 409.
            if (outcome.reason.startsWith('unknown deployment')) {
              respond(404, { error: outcome.reason });
            } else {
              respond(409, { error: outcome.reason });
            }
            return;
          }
          respond(200, outcome);
        });
      } else {
        json(res, 501, { error: 'deployment registry not configured' });
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

function parseListRankedArgs(searchParams: URLSearchParams): ListRankedArgs {
  if (searchParams.size === 0) return {};
  const args: ListRankedArgs = {};
  const filters: ListFilters = {};
  const status = searchParams.get('filters.status');
  if (status !== null) filters.status = status.split(',');
  const riskClass = searchParams.get('filters.risk_class');
  if (riskClass !== null) filters.risk_class = riskClass.split(',');
  const deployment = searchParams.get('filters.deployment');
  if (deployment !== null) filters.deployment = deployment.split(',');
  if (Object.keys(filters).length > 0) args.filters = filters;

  const focusDeployments = searchParams.get('focusDeployments');
  if (focusDeployments !== null) {
    args.focus = {
      now: new Date(),
      focusDeployments: focusDeployments.split(','),
    };
  }

  const includeSuppressed = searchParams.get('includeSuppressed');
  if (includeSuppressed === 'true') args.includeSuppressed = true;
  return args;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
