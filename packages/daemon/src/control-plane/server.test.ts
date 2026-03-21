import { describe, it, expect, afterEach, vi } from 'vitest';
import { createControlServer } from './server.js';
import { ok, err } from '../lib/result.js';
import type { Server } from 'http';

const PORT = 19876; // high port unlikely to conflict
let serverRef: Server | undefined;

afterEach(() => {
  if (serverRef) { serverRef.close(); serverRef = undefined; }
});

const handlers = {
  getStatus: () => ({ activeRuns: 0, dailyCost: 1.5, paused: false }),
  pause: () => {},
  resume: () => {},
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
    const res = await fetch(`http://127.0.0.1:${PORT}/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
  });

  it('POST /retry/42 succeeds', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/retry/42`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('POST /retry/999 returns 404', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/retry/999`, { method: 'POST' });
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
      const res = await fetch(`http://127.0.0.1:${PORT + 2}/repos/reload`, { method: 'POST' });
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
      const res = await fetch(`http://127.0.0.1:${PORT + 3}/remote-control/restart`, { method: 'POST' });
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
    const res = await fetch(`http://127.0.0.1:${PORT}/remote-control/restart`, { method: 'POST' });
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
      const res = await fetch(`http://127.0.0.1:${PORT + 4}/issues/scan`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scanned).toBe(3);
    } finally {
      server.close();
    }
  });

  it('POST /issues/scan returns 501 when handler not wired', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${PORT}/issues/scan`, { method: 'POST' });
    expect(res.status).toBe(501);
  });

  it('GET /status includes remote_control fields', async () => {
    const { server: s2, start: start2 } = createControlServer(PORT + 1, {
      getStatus: () => ({
        activeRuns: 0,
        dailyCost: 0,
        paused: false,
        remote_control_url: 'https://claude.ai/remote/test',
        remote_control_state: 'active',
      }),
      pause: () => {},
      resume: () => {},
      retry: () => ok(undefined),
    });
    const result2 = await start2();
    expect(result2.ok).toBe(true);

    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/status`);
      const body = await res.json();
      expect(body.remote_control_url).toBe('https://claude.ai/remote/test');
      expect(body.remote_control_state).toBe('active');
    } finally {
      s2.close();
    }
  });
});
