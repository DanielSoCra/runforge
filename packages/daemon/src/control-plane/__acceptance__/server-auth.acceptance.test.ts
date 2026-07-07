import { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlServer, type ControlHandlers } from '../server.js';
import { ControlBindError } from '../control-auth.js';

const controlToken = 'secrettoken';
const wrongToken = 'wrongtoken1';

let originalControlToken: string | undefined;
let serverRef: HttpServer | undefined;

const handlers: ControlHandlers = {
  getStatus: () => ({ activeRuns: 0, dailyCost: 1.5, paused: false }),
  pause: () => {},
  resume: () => {},
  drain: () => {},
  cancelDrain: () => {},
  halt: async () => ({
    halted: true,
    parked: [],
    terminated: 0,
    escalated: 0,
  }),
  retry: async (issueNumber: number) => ({
    status: 200 as const,
    body: { retrying: issueNumber },
  }),
};

beforeEach(() => {
  originalControlToken = process.env.RUNFORGE_CONTROL_TOKEN;
});

afterEach(async () => {
  if (serverRef) {
    const server = serverRef;
    serverRef = undefined;
    await closeServer(server);
  }

  if (originalControlToken === undefined) {
    delete process.env.RUNFORGE_CONTROL_TOKEN;
  } else {
    process.env.RUNFORGE_CONTROL_TOKEN = originalControlToken;
  }

  vi.restoreAllMocks();
});

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startServer(): Promise<{ port: number }> {
  const { server, start } = createControlServer(0, handlers, '127.0.0.1');
  serverRef = server;

  const result = await start();
  if (!result.ok) throw result.error;

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('control server did not expose an ephemeral port');
  }

  return { port: (address as AddressInfo).port };
}

function expectNotAuthFailure(status: number): void {
  expect([401, 403]).not.toContain(status);
}

describe('control server bearer enforcement', () => {
  it('requires bearer auth on control routes when RUNFORGE_CONTROL_TOKEN is set', async () => {
    process.env.RUNFORGE_CONTROL_TOKEN = controlToken;
    const { port } = await startServer();

    const pauseWithoutBearer = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'acceptance-test' },
    });
    expect(pauseWithoutBearer.status).toBe(401);

    const pauseWithWrongBearer = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wrongToken}`,
        'X-Requested-By': 'acceptance-test',
      },
    });
    expect(pauseWithWrongBearer.status).toBe(403);

    const pauseWithBearer = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${controlToken}`,
        'X-Requested-By': 'acceptance-test',
      },
    });
    expectNotAuthFailure(pauseWithBearer.status);

    const statusWithoutBearer = await fetch(`http://127.0.0.1:${port}/status`);
    expect(statusWithoutBearer.status).toBe(401);

    const statusWithBearer = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    expectNotAuthFailure(statusWithBearer.status);

    const healthWithoutBearer = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthWithoutBearer.status).toBe(200);

    const haltWithoutBearer = await fetch(`http://127.0.0.1:${port}/halt`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'acceptance-test' },
    });
    expect(haltWithoutBearer.status).toBe(401);

    const haltWithBearer = await fetch(`http://127.0.0.1:${port}/halt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${controlToken}`,
        'X-Requested-By': 'acceptance-test',
      },
    });
    expectNotAuthFailure(haltWithBearer.status);
  });

  it('keeps legacy loopback access when RUNFORGE_CONTROL_TOKEN is unset', async () => {
    delete process.env.RUNFORGE_CONTROL_TOKEN;
    const { port } = await startServer();

    const pause = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: { 'X-Requested-By': 'acceptance-test' },
    });
    expectNotAuthFailure(pause.status);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expectNotAuthFailure(status.status);
  });

  it('retains the X-Requested-By CSRF check after valid bearer auth', async () => {
    process.env.RUNFORGE_CONTROL_TOKEN = controlToken;
    const { port } = await startServer();

    const response = await fetch(`http://127.0.0.1:${port}/pause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${controlToken}` },
    });

    expect(response.status).toBe(403);
  });

  it('refuses tokenless non-loopback binds before listening', async () => {
    delete process.env.RUNFORGE_CONTROL_TOKEN;

    const listenSpy = vi.spyOn(HttpServer.prototype, 'listen');
    listenSpy.mockImplementation(function (this: HttpServer): HttpServer {
      throw new Error('listen should not be reached for tokenless non-loopback bind');
    });

    let handle: ReturnType<typeof createControlServer> | undefined;
    let failure: unknown;

    try {
      handle = createControlServer(0, handlers, '0.0.0.0');
      serverRef = handle.server;
      const result = await handle.start();
      if (!result.ok) failure = result.error;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ControlBindError);
    expect(listenSpy).not.toHaveBeenCalled();
    expect(handle?.server.listening ?? false).toBe(false);
  });
});
