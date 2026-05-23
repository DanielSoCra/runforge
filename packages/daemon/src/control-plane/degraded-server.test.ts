import { afterEach, describe, expect, it } from 'vitest';

import type { ConfigFetchError } from '../data/config-reader.js';
import { createDegradedServer, type DegradedState } from './degraded-server.js';

const HOST = '127.0.0.1';
// High, unlikely-to-collide ports for the suite.
const PORT = 47821;

const sampleError: ConfigFetchError = {
  category: 'unreachable',
  cause: {
    class: 'Error',
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED 127.0.0.1:5432',
  },
};

let toClose: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const handle of toClose) await handle.close();
  toClose = [];
});

function startServer(port: number, state: DegradedState) {
  const { start, handle } = createDegradedServer(port, HOST, () => state);
  toClose.push(handle);
  return { start, handle };
}

describe('createDegradedServer', () => {
  it('/health returns the degraded shape with the injected lastConfigError', async () => {
    const { start } = startServer(PORT, { lastConfigError: sampleError });
    const result = await start();
    expect(result.ok).toBe(true);

    const res = await fetch(`http://${HOST}:${PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      degraded: true,
      lastConfigError: sampleError,
    });
  });

  it('/status returns degraded with uptime', async () => {
    const { start } = startServer(PORT, { lastConfigError: null });
    await start();

    const res = await fetch(`http://${HOST}:${PORT}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.degraded).toBe(true);
    expect(body.lastConfigError).toBeNull();
    expect(typeof body.uptime).toBe('number');
  });

  it('unknown path returns 503', async () => {
    const { start } = startServer(PORT, { lastConfigError: null });
    await start();

    const res = await fetch(`http://${HOST}:${PORT}/dashboard`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'daemon starting (degraded)' });
  });

  it('reflects live state mutations via getState', async () => {
    const state: DegradedState = { lastConfigError: null };
    const { start, handle } = createDegradedServer(PORT, HOST, () => state);
    toClose.push(handle);
    await start();

    state.lastConfigError = sampleError;
    const res = await fetch(`http://${HOST}:${PORT}/health`);
    expect(((await res.json()) as { lastConfigError: unknown }).lastConfigError).toEqual(
      sampleError,
    );
  });

  it('close() releases the port so a second start() on the same port succeeds', async () => {
    const first = startServer(PORT, { lastConfigError: null });
    expect((await first.start()).ok).toBe(true);
    await first.handle.close();

    const second = startServer(PORT, { lastConfigError: null });
    const result = await second.start();
    expect(result.ok).toBe(true);
  });

  it('close() is idempotent and safe to call when never started', async () => {
    const { handle } = createDegradedServer(PORT, HOST, () => ({
      lastConfigError: null,
    }));
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
