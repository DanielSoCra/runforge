import { describe, it, expect, afterEach, vi } from 'vitest';
import { createControlServer, type ControlHandlers } from './server.js';
import { ok, err } from '../lib/result.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import * as results from './results.js';
import { DeploymentRegistry } from './deployment-registry/registry.js';
import type { RiskClass, AutonomyLevel } from './deployment-registry/types.js';

let serverRef: Server | undefined;

// Close a server and await the close, clearing serverRef if it's the one being
// closed so afterEach doesn't issue a redundant second close (handle leak /
// timing-dependent failures under load).
async function closeServer(s: Server): Promise<void> {
  if (serverRef === s) serverRef = undefined;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

// True ONLY for the "another process grabbed the freed ephemeral port between
// close and rebind" race. createControlServer.start() (server.ts) reports this
// in exactly two shapes:
//   - EADDRINUSE wrapped as a FRESH Error (no .code):
//       `Instance lock failed — port <port> in use (another instance is running)`
//   - any other listen error: the original error, which carries `.code`.
// We match the exact instance-lock message OR a literal EADDRINUSE code — not a
// loose substring — so a real (non-race) start() failure surfaces immediately
// instead of being silently retried.
function isPortRaceError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EADDRINUSE') return true;
  const msg = error instanceof Error ? error.message : '';
  return /^Instance lock failed — port \d+ in use/.test(msg);
}

afterEach(async () => {
  if (serverRef) {
    const s = serverRef;
    serverRef = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const handlers = {
  getStatus: () => ({ activeRuns: 0, dailyCost: 1.5, paused: false }),
  pause: () => {},
  resume: () => {},
  drain: () => {},
  cancelDrain: () => {},
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

// Bind on port 0 so the OS assigns a free ephemeral port; the real port is
// readable via server.address() only AFTER start() resolves. This eliminates
// cross-process port collisions from fixed literals.
async function startServer(overrides: Partial<ControlHandlers> = {}) {
  const { server, start } = createControlServer(0, { ...handlers, ...overrides });
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
  const port = (server.address() as AddressInfo).port;
  return { server, start, result, port };
}

describe('ControlServer', () => {
  it('GET /health returns ok', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, degraded: false, lastConfigError: null });
  });

  it('GET /status returns daemon status', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeRuns).toBe(0);
    expect(body.dailyCost).toBe(1.5);
  });

  it('POST /pause returns paused', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
  });

  it('GET /decisions/:id decodes a URL-encoded decision id before lookup (codex)', async () => {
    let receivedId: string | undefined;
    const { port } = await startServer({
      getDecisionDetail: (id: string) => {
        receivedId = id;
        return { status: 404, body: { error: 'unknown decision' } };
      },
    });
    // Decision ids carry colons; the client percent-encodes them in the path.
    const encoded = encodeURIComponent('issue-42:l2-gate:1');
    const res = await fetch(`http://127.0.0.1:${port}/decisions/${encoded}`);
    expect(res.status).toBe(404); // handler's verdict; the point is the decoded id reached it
    expect(receivedId).toBe('issue-42:l2-gate:1');
  });

  it('POST /resume can reject a blocked resume', async () => {
    const { server, port } = await startServer({
      resume: async () => err(new Error('runtime source unhealthy')),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/resume`, {
        method: 'POST',
        headers: { 'X-Requested-By': 'test' },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({
        paused: true,
        error: 'runtime source unhealthy',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('POST /retry/42 succeeds', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/retry/42`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(200);
  });

  it('POST /retry/999 returns 404', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/retry/999`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(404);
  });

  it('rejects second instance on same port', async () => {
    // Server A grabs an OS-assigned ephemeral port; server B then tries to bind
    // that exact port and must be rejected by the instance lock.
    const { port } = await startServer();
    const { start: start2, server: server2 } = createControlServer(port, handlers);
    const result = await start2();
    expect(result.ok).toBe(false);
    // Assert the rejection is specifically the production instance-lock signal
    // (`Instance lock failed — port <port> in use ...`), so an unrelated
    // startup regression can't masquerade as a false green.
    if (!result.ok) {
      expect(result.error.message).toMatch(/^Instance lock failed — port \d+ in use/);
    }
    await closeServer(server2);
  });

  it('POST /repos/reload calls reloadRepos and returns count', async () => {
    const { server, port } = await startServer({
      reloadRepos: async () => ({ active: 3 }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/reload`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reloaded).toBe(true);
      expect(body.active).toBe(3);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /remote-control/restart calls restartRemoteControl', async () => {
    const restarted = vi.fn();
    const { server, port } = await startServer({
      restartRemoteControl: restarted,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/remote-control/restart`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.restarted).toBe(true);
      expect(restarted).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /remote-control/restart returns 501 when handler not wired', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/remote-control/restart`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(501);
  });

  it('POST /issues/scan calls scanIssues and returns count', async () => {
    const { server, port } = await startServer({
      scanIssues: async () => ({ scanned: 3 }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scanned).toBe(3);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /issues/scan returns 501 when handler not wired', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(501);
  });

  it('POST /release calls release handler and returns release proposal details', async () => {
    const release = vi.fn().mockResolvedValue({
      status: 'success',
      prNumber: 12,
      prUrl: 'https://github.com/example/repo/pull/12',
      issueCount: 2,
      totalCost: 3.5,
    });
    const { server, port } = await startServer({
      release,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/release`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'success',
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        issueCount: 2,
        totalCost: 3.5,
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /release returns 501 when handler not wired', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/release`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(501);
  });

  it('POST /po/interactive-session invokes the launch handler and returns its result', async () => {
    const startInteractivePoSession = vi.fn().mockResolvedValue({
      status: 200,
      body: { sessionId: 'sess-1', endReason: 'explicit_close', summary: 'done' },
    });
    const { server, port } = await startServer({ startInteractivePoSession });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/po/interactive-session`, {
        method: 'POST',
        headers: { 'X-Requested-By': 'test' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sessionId: 'sess-1',
        endReason: 'explicit_close',
        summary: 'done',
      });
      expect(startInteractivePoSession).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /po/interactive-session propagates a 409 when a session is already active', async () => {
    const startInteractivePoSession = vi.fn().mockResolvedValue({
      status: 409,
      body: { error: 'an interactive PO session is already active' },
    });
    const { server, port } = await startServer({ startInteractivePoSession });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/po/interactive-session`, {
        method: 'POST',
        headers: { 'X-Requested-By': 'test' },
      });
      expect(res.status).toBe(409);
    } finally {
      await closeServer(server);
    }
  });

  it('POST /po/interactive-session returns 501 when handler not wired', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/po/interactive-session`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'test' },
    });
    expect(res.status).toBe(501);
  });

  it('re-listen on the same port succeeds immediately after a clean close', async () => {
    // This test makes no HTTP request — it only proves a port can be re-bound
    // right after a clean server.close(), with no lingering instance-lock or
    // TIME_WAIT block. We pin the port (allocate ephemeral, close, rebind that
    // exact number) so the rebind exercises the same-port path. Under load
    // another process can steal the port in the gap between close and rebind,
    // so we bound-retry on EADDRINUSE with a fresh ephemeral port each attempt.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    let rebound = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !rebound; attempt += 1) {
      // Allocate an ephemeral port via a first bind, capture it, then close.
      const { server: server1, start: start1 } = createControlServer(0, handlers);
      const r1 = await start1();
      expect(r1.ok).toBe(true);
      const port = (server1.address() as AddressInfo).port;
      await new Promise<void>((resolve) => server1.close(() => resolve()));

      // Rebind on that exact port.
      const { server: server2, start: start2 } = createControlServer(port, handlers);
      const r2 = await start2();
      if (r2.ok) {
        serverRef = server2;
        rebound = true;
      } else if (isPortRaceError(r2.error)) {
        // Another process grabbed the freed port between close and rebind.
        // Retry with a fresh ephemeral allocation.
        lastErr = r2.error;
        await closeServer(server2);
      } else {
        // Not the stolen-port race — a real rebind/startup regression. Surface
        // it immediately rather than collapsing it into the generic message.
        await closeServer(server2);
        throw r2.error;
      }
    }
    expect(rebound, `rebind failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`).toBe(true);
  });

  it('rejects POST without X-Requested-By header (CSRF protection)', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/X-Requested-By/);
  });

  it('allows POST with X-Requested-By header', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'test' },
    });
    expect(res.status).toBe(200);
  });

  it('allows GET requests without X-Requested-By header', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('returns 500 with error body when /api/runs handler fails (#150)', async () => {
    const runsError = new Error('disk full');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readSpy = vi.spyOn(results, 'readResults').mockRejectedValueOnce(runsError);
    const { port } = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: 'read failed' });
      expect(spy).toHaveBeenCalledWith(
        '[control-plane] GET /api/runs failed:',
        runsError,
      );
    } finally {
      spy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('logs error to console.error when /repos/reload handler fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadError = new Error('db connection lost');
    const { server, port } = await startServer({
      reloadRepos: async () => { throw reloadError; },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repos/reload`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(
        '[control-plane] POST /repos/reload failed:',
        reloadError,
      );
    } finally {
      await closeServer(server);
      spy.mockRestore();
    }
  });

  it('logs error to console.error when /issues/scan handler fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scanError = new Error('GitHub API rate limited');
    const { server, port } = await startServer({
      scanIssues: async () => { throw scanError; },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(
        '[control-plane] POST /issues/scan failed:',
        scanError,
      );
    } finally {
      await closeServer(server);
      spy.mockRestore();
    }
  });

  it('binds to custom host when provided (Docker compatibility)', async () => {
    // Regression test for #147: daemon must accept a configurable bind host
    // so it can bind 0.0.0.0 in Docker for cross-container access
    const { server, start } = createControlServer(0, handlers, '0.0.0.0');
    const result = await start();
    expect(result.ok).toBe(true);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      // Verify the server actually bound to 0.0.0.0, not the default
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        expect(addr.address).toBe('0.0.0.0');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('defaults to 127.0.0.1 when no host provided (secure default)', async () => {
    // Regression test for #147: without explicit host, server should bind loopback only
    const { server, start } = createControlServer(0, handlers);
    const result = await start();
    expect(result.ok).toBe(true);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      // Verify address is loopback
      const addr = server.address();
      expect(addr).not.toBeNull();
      if (typeof addr === 'object' && addr !== null) {
        expect(addr.address).toBe('127.0.0.1');
      }
    } finally {
      await closeServer(server);
    }
  });

  it('POST /drain calls drain handler and returns draining:true (#425)', async () => {
    const drain = vi.fn();
    const { server, port } = await startServer({ drain });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/drain`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ draining: true });
      expect(drain).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /drain/cancel calls cancelDrain handler and returns draining:false (#425)', async () => {
    const cancelDrain = vi.fn();
    const { server, port } = await startServer({ cancelDrain });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/drain/cancel`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ draining: false });
      expect(cancelDrain).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it('POST /drain rejects missing X-Requested-By (CSRF protection) (#425)', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/drain`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('POST /drain/cancel rejects missing X-Requested-By (CSRF protection) (#425)', async () => {
    const { port } = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/drain/cancel`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('GET /status includes remote_control_state but not remote_control_url', async () => {
    const { server: s2, start: start2 } = createControlServer(0, {
      getStatus: () => ({
        activeRuns: 0,
        dailyCost: 0,
        paused: false,
        remote_control_state: 'active',
      }),
      pause: () => {},
      resume: () => {},
      drain: () => {},
      cancelDrain: () => {},
      retry: () => ok(undefined),
    });
    const result2 = await start2();
    expect(result2.ok).toBe(true);
    const port = (s2.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      const body = await res.json();
      expect(body.remote_control_state).toBe('active');
      expect(body.remote_control_url).toBeUndefined();
    } finally {
      await closeServer(s2);
    }
  });

  describe('POST /deployments/:id/widen', () => {
    function makeProfile() {
      return {
        repositories: [{ owner: 'acme', name: 'auto-claude' }],
        riskPathMap: [{ paths: ['infra/**'], minLevel: 'orange' }],
        defaultMinLevel: 'green',
        laneSet: {
          declaredPhases: ['velocity'],
          mostCautiousLane: 'standard',
          lanes: [
            {
              name: 'fast',
              qualify: { complexity: ['simple'] },
              allowedPaths: ['**'],
              roleRouting: { implement: 'cheap-implementer' },
              gateSet: 'gate1',
              mergePolicy: 'auto',
            },
            {
              name: 'standard',
              qualify: { complexity: ['standard', 'complex'] },
              allowedPaths: ['**'],
              roleRouting: { implement: 'cheap-implementer' },
              gateSet: 'gate1',
              mergePolicy: 'auto',
            },
          ],
        },
        lifecycleMode: 'velocity',
        complianceReviewers: [],
        honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
        budget: 5000,
        landing: { landsOn: 'main', productionReleasePath: 'tag-and-deploy' },
        capabilityBindings: [],
      };
    }

    function widenHandler(reg: DeploymentRegistry) {
      return (
        id: string,
        grant: {
          riskClass: RiskClass;
          target: AutonomyLevel;
          lane?: string;
          operator: string;
        },
      ) =>
        reg.recordWidening(
          id,
          grant.riskClass,
          grant.target,
          { kind: 'operator-grant', operator: grant.operator },
          Date.now(),
          grant.lane,
        );
    }

    function levelFor(
      reg: DeploymentRegistry,
      id: string,
      rc: RiskClass,
      lane?: string,
    ): string | undefined {
      return reg.readAutonomyState(id, rc, lane).find((e) => e.riskClass === rc)?.level;
    }

    it('returns 400 when the body is missing required fields', async () => {
      const reg = new DeploymentRegistry();
      const { port } = await startServer({
        widenAutonomy: widenHandler(reg),
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/deployments/dep-a/widen`,
        {
          method: 'POST',
          headers: {
            'X-Requested-By': 'test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ target: 'widened', operator: 'daniel' }),
        },
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when the body is not an object', async () => {
      const reg = new DeploymentRegistry();
      const { port } = await startServer({
        widenAutonomy: widenHandler(reg),
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/deployments/dep-a/widen`,
        {
          method: 'POST',
          headers: {
            'X-Requested-By': 'test',
            'Content-Type': 'application/json',
          },
          body: '"not-an-object"',
        },
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown deployment', async () => {
      const reg = new DeploymentRegistry();
      const { port } = await startServer({
        widenAutonomy: widenHandler(reg),
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/deployments/dep-a/widen`,
        {
          method: 'POST',
          headers: {
            'X-Requested-By': 'test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            riskClass: 'green',
            target: 'widened',
            operator: 'daniel',
          }),
        },
      );
      expect(res.status).toBe(404);
    });

    it('returns 200 and records the widening for a valid request', async () => {
      const reg = new DeploymentRegistry();
      reg.register('dep-a', makeProfile() as never);
      const { server, port } = await startServer({
        widenAutonomy: widenHandler(reg),
      });
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/deployments/dep-a/widen`,
          {
            method: 'POST',
            headers: {
              'X-Requested-By': 'test',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              riskClass: 'green',
              target: 'widened',
              lane: 'fast',
              operator: 'daniel',
            }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean };
        expect(body.ok).toBe(true);
        expect(levelFor(reg, 'dep-a', 'green', 'fast')).toBe('widened');
      } finally {
        await closeServer(server);
      }
    });
  });
});
