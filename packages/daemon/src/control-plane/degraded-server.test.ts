import { createServer } from 'net';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConfigFetchError } from '../data/config-reader.js';
import { createDegradedServer, type DegradedState } from './degraded-server.js';
import { ControlBindError } from './control-auth.js';

const HOST = '127.0.0.1';

const sampleError: ConfigFetchError = {
  category: 'unreachable',
  cause: {
    class: 'Error',
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED 127.0.0.1:5432',
  },
};

let toClose: { close: () => Promise<void> }[] = [];
let originalControlToken: string | undefined;

beforeEach(() => {
  originalControlToken = process.env.RUNFORGE_CONTROL_TOKEN;
});

afterEach(async () => {
  for (const handle of toClose) await handle.close();
  toClose = [];

  if (originalControlToken === undefined) {
    delete process.env.RUNFORGE_CONTROL_TOKEN;
  } else {
    process.env.RUNFORGE_CONTROL_TOKEN = originalControlToken;
  }
});

// createDegradedServer's handle does not expose the underlying server, so the
// test cannot read back an OS-assigned port after start(). Instead we probe a
// free ephemeral port (bind a throwaway net server on 0, read it, close it)
// and hand that concrete number to createDegradedServer. This avoids fixed
// literals and the cross-process collisions they cause. We do NOT touch
// production code. There's an inherent race — another process can grab the
// freed port before createDegradedServer binds — so callers that bind via
// startServerOnFreePort() get a bounded EADDRINUSE retry.
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function makeServer(port: number, state: DegradedState) {
  const { start, handle } = createDegradedServer(port, HOST, () => state);
  toClose.push(handle);
  return { start, handle };
}

// True ONLY for the "another process grabbed the freed ephemeral port" race.
// createDegradedServer.start() (degraded-server.ts) reports this in exactly two
// shapes — identical to the control server:
//   - EADDRINUSE wrapped as a FRESH Error (no .code):
//       `Instance lock failed — port <port> in use (another instance is running)`
//   - any other listen error: the original error, which carries `.code`.
// Match the exact instance-lock message OR a literal EADDRINUSE code — not a
// loose substring — so a real (non-race) start() failure surfaces immediately
// instead of being silently retried/masked.
function isPortRaceError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EADDRINUSE') return true;
  const msg = error instanceof Error ? error.message : '';
  return /^Instance lock failed — port \d+ in use/.test(msg);
}

// Probe a free port, bind a degraded server on it, and start(). Retries ONLY on
// the stolen-port race (port grabbed between probe-close and bind) with a fresh
// port. Any other start() failure is surfaced immediately.
async function startServerOnFreePort(
  state: DegradedState,
): Promise<{ handle: { close: () => Promise<void> }; port: number }> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = await freePort();
    const { start, handle } = makeServer(port, state);
    const result = await start();
    if (result.ok) {
      return { handle, port };
    }
    await handle.close();
    if (!isPortRaceError(result.error)) {
      // Not the stolen-port race — a real bind/startup regression. Surface it
      // immediately rather than collapsing it into the generic message.
      throw result.error;
    }
    lastErr = result.error;
  }
  throw new Error(`could not bind a degraded server after ${MAX_ATTEMPTS} attempts (port race): ${String(lastErr)}`);
}

describe('createDegradedServer', () => {
  it('/health returns the degraded shape with the injected lastConfigError', async () => {
    const { port } = await startServerOnFreePort({ lastConfigError: sampleError });

    const res = await fetch(`http://${HOST}:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      degraded: true,
      lastConfigError: sampleError,
    });
  });

  it('/status returns degraded with uptime', async () => {
    const { port } = await startServerOnFreePort({ lastConfigError: null });

    const res = await fetch(`http://${HOST}:${port}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.degraded).toBe(true);
    expect(body.lastConfigError).toBeNull();
    expect(typeof body.uptime).toBe('number');
  });

  it('unknown path returns 503', async () => {
    const { port } = await startServerOnFreePort({ lastConfigError: null });

    const res = await fetch(`http://${HOST}:${port}/dashboard`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon starting (degraded)' });
  });

  it('reflects live state mutations via getState', async () => {
    const state: DegradedState = { lastConfigError: null };
    const { port } = await startServerOnFreePort(state);

    state.lastConfigError = sampleError;
    const res = await fetch(`http://${HOST}:${port}/health`);
    expect(((await res.json()) as { lastConfigError: unknown }).lastConfigError).toEqual(
      sampleError,
    );
  });

  it('close() releases the port so a second start() on the same port succeeds', async () => {
    // Bind on a captured free port, close it, then rebind that exact port to
    // prove close() releases it. Another process may steal the freed port in
    // the gap, so we bound-retry the allocate→close→rebind cycle.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    let rebound = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !rebound; attempt += 1) {
      const port = await freePort();
      const first = makeServer(port, { lastConfigError: null });
      expect((await first.start()).ok).toBe(true);
      await first.handle.close();

      const second = makeServer(port, { lastConfigError: null });
      const result = await second.start();
      if (result.ok) {
        rebound = true;
      } else {
        await second.handle.close();
        if (!isPortRaceError(result.error)) {
          // Not the stolen-port race — a real regression (e.g. close() did NOT
          // release the port). Surface it immediately, not as a masked retry.
          throw result.error;
        }
        lastErr = result.error;
      }
    }
    expect(rebound, `rebind failed after ${MAX_ATTEMPTS} attempts (port race): ${String(lastErr)}`).toBe(true);
  });

  it('close() is idempotent and safe to call when never started', async () => {
    const port = await freePort();
    const { handle } = createDegradedServer(port, HOST, () => ({
      lastConfigError: null,
    }));
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('requires bearer auth on /status when RUNFORGE_CONTROL_TOKEN is set', async () => {
    process.env.RUNFORGE_CONTROL_TOKEN = 'testtoken';
    const { port } = await startServerOnFreePort({ lastConfigError: null });

    const withoutBearer = await fetch(`http://${HOST}:${port}/status`);
    expect(withoutBearer.status).toBe(401);

    const withWrongBearer = await fetch(`http://${HOST}:${port}/status`, {
      headers: { Authorization: 'Bearer wrongtoken' },
    });
    expect(withWrongBearer.status).toBe(403);

    const withBearer = await fetch(`http://${HOST}:${port}/status`, {
      headers: { Authorization: 'Bearer testtoken' },
    });
    expect(withBearer.status).toBe(200);
  });

  it('/health stays open even when RUNFORGE_CONTROL_TOKEN is set', async () => {
    process.env.RUNFORGE_CONTROL_TOKEN = 'testtoken';
    const { port } = await startServerOnFreePort({ lastConfigError: null });

    const res = await fetch(`http://${HOST}:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('refuses tokenless non-loopback binds before listening', async () => {
    delete process.env.RUNFORGE_CONTROL_TOKEN;
    const port = await freePort();
    expect(() => createDegradedServer(port, '0.0.0.0', () => ({ lastConfigError: null }))).toThrow(
      ControlBindError,
    );
  });
});
