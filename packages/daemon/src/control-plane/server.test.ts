import { describe, it, expect, afterEach, vi } from 'vitest';
import { createControlServer } from './server.js';
import { ok, err } from '../lib/result.js';
import type { Server } from 'http';
import * as results from './results.js';

const PORT = 19876; // high port unlikely to conflict
let serverRef: Server | undefined;

afterEach(() => {
  if (serverRef) { serverRef.close(); serverRef = undefined; }
});

const handlers = {
  getStatus: () => ({ activeRuns: 0, dailyCost: 1.5, paused: false }),
  pause: () => {},
  resume: () => {},
  drain: () => {},
  cancelDrain: () => {},
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

async function startServer() {
  const { server, start } = createControlServer(PORT, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
  return server;
}

describe('ControlServer', () => {
  it('GET /health returns ok', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('GET /status returns daemon status', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeRuns).toBe(0);
    expect(body.dailyCost).toBe(1.5);
  });

  it('POST /pause returns paused', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/pause`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
  });

  it('POST /retry/42 succeeds', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/retry/42`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(200);
  });

  it('POST /retry/999 returns 404', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/retry/999`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(404);
  });

  it('rejects second instance on same port', async () => {
    await startServer();
    const { start: start2, server: server2 } = createControlServer(PORT, handlers);
    const result = await start2();
    expect(result.ok).toBe(false);
    server2.close();
  });

  it('POST /repos/reload calls reloadRepos and returns count', async () => {
    const { server, start } = createControlServer(PORT + 2, {
      ...handlers,
      reloadRepos: async () => ({ active: 3 }),
    });
    const result = await start();
    expect(result.ok).toBe(true);

    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 2}/repos/reload`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reloaded).toBe(true);
      expect(body.active).toBe(3);
    } finally {
      server.close();
    }
  });

  it('POST /remote-control/restart calls restartRemoteControl', async () => {
    const restarted = vi.fn();
    const { server, start } = createControlServer(PORT + 3, {
      ...handlers,
      restartRemoteControl: restarted,
    });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 3}/remote-control/restart`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.restarted).toBe(true);
      expect(restarted).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it('POST /remote-control/restart returns 501 when handler not wired', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/remote-control/restart`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(501);
  });

  it('POST /issues/scan calls scanIssues and returns count', async () => {
    const { server, start } = createControlServer(PORT + 4, {
      ...handlers,
      scanIssues: async () => ({ scanned: 3 }),
    });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 4}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scanned).toBe(3);
    } finally {
      server.close();
    }
  });

  it('POST /issues/scan returns 501 when handler not wired', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
    expect(res.status).toBe(501);
  });

  it('allows immediate rebind after close (SO_REUSEADDR / no TIME_WAIT block)', async () => {
    const server1 = await startServer();
    // Close the first server and immediately try to rebind the same port
    await new Promise<void>((resolve) => server1.close(() => resolve()));
    serverRef = undefined;
    // If SO_REUSEADDR is not set, this would fail with EADDRINUSE due to TIME_WAIT
    const { server: server2, start: start2 } = createControlServer(PORT, handlers);
    serverRef = server2;
    const result = await start2();
    expect(result.ok).toBe(true);
  });

  it('rejects POST without X-Requested-By header (CSRF protection)', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/pause`, { method: 'POST' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/X-Requested-By/);
  });

  it('allows POST with X-Requested-By header', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'test' },
    });
    expect(res.status).toBe(200);
  });

  it('allows GET requests without X-Requested-By header', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
  });

  it('returns 500 with error body when /api/runs handler fails (#150)', async () => {
    const runsError = new Error('disk full');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readSpy = vi.spyOn(results, 'readResults').mockRejectedValueOnce(runsError);
    await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/runs`);
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
    const { server, start } = createControlServer(PORT + 6, {
      ...handlers,
      reloadRepos: async () => { throw reloadError; },
    });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 6}/repos/reload`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(
        '[control-plane] POST /repos/reload failed:',
        reloadError,
      );
    } finally {
      server.close();
      spy.mockRestore();
    }
  });

  it('logs error to console.error when /issues/scan handler fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scanError = new Error('GitHub API rate limited');
    const { server, start } = createControlServer(PORT + 7, {
      ...handlers,
      scanIssues: async () => { throw scanError; },
    });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 7}/issues/scan`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(
        '[control-plane] POST /issues/scan failed:',
        scanError,
      );
    } finally {
      server.close();
      spy.mockRestore();
    }
  });

  it('binds to custom host when provided (Docker compatibility)', async () => {
    // Regression test for #147: daemon must accept a configurable bind host
    // so it can bind 0.0.0.0 in Docker for cross-container access
    const { server, start } = createControlServer(PORT + 8, handlers, '0.0.0.0');
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 8}/health`);
      expect(res.status).toBe(200);
      // Verify the server actually bound to 0.0.0.0, not the default
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        expect(addr.address).toBe('0.0.0.0');
      }
    } finally {
      server.close();
    }
  });

  it('defaults to 127.0.0.1 when no host provided (secure default)', async () => {
    // Regression test for #147: without explicit host, server should bind loopback only
    const { server, start } = createControlServer(PORT + 9, handlers);
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 9}/health`);
      expect(res.status).toBe(200);
      // Verify address is loopback
      const addr = server.address();
      expect(addr).not.toBeNull();
      if (typeof addr === 'object' && addr !== null) {
        expect(addr.address).toBe('127.0.0.1');
      }
    } finally {
      server.close();
    }
  });

  it('POST /drain calls drain handler and returns draining:true (#425)', async () => {
    const drain = vi.fn();
    const { server, start } = createControlServer(PORT + 10, { ...handlers, drain });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 10}/drain`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ draining: true });
      expect(drain).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it('POST /drain/cancel calls cancelDrain handler and returns draining:false (#425)', async () => {
    const cancelDrain = vi.fn();
    const { server, start } = createControlServer(PORT + 11, { ...handlers, cancelDrain });
    const result = await start();
    expect(result.ok).toBe(true);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 11}/drain/cancel`, { method: 'POST', headers: { 'X-Requested-By': 'test' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ draining: false });
      expect(cancelDrain).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });

  it('POST /drain rejects missing X-Requested-By (CSRF protection) (#425)', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/drain`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('POST /drain/cancel rejects missing X-Requested-By (CSRF protection) (#425)', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/drain/cancel`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('GET /status includes remote_control_state but not remote_control_url', async () => {
    const { server: s2, start: start2 } = createControlServer(PORT + 1, {
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

    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/status`);
      const body = await res.json();
      expect(body.remote_control_state).toBe('active');
      expect(body.remote_control_url).toBeUndefined();
    } finally {
      s2.close();
    }
  });
});
