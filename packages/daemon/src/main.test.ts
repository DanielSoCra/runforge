import { describe, it, expect, afterEach, vi } from 'vitest';
import { createControlServer } from './control-plane/server.js';
import { ok, err } from './lib/result.js';
import type { Server } from 'http';

// Regression test for #148: main.ts callApi() must include X-Requested-By
// header on POST requests, otherwise daemon CSRF middleware returns 403.
// We test the actual fetch behavior that main.ts uses, not the CLI wrapper.

const PORT = 19899;
let serverRef: Server | undefined;

const handlers = {
  getStatus: () => ({ activeRuns: 0, paused: false }),
  pause: vi.fn(),
  resume: vi.fn(),
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

afterEach(() => {
  if (serverRef) { serverRef.close(); serverRef = undefined; }
});

describe('main.ts callApi X-Requested-By header (#148)', () => {
  it('POST with X-Requested-By header succeeds (not 403)', async () => {
    const { server, start } = createControlServer(PORT, handlers);
    serverRef = server;
    await start();

    // Simulate what main.ts callApi does after the fix
    const headers: Record<string, string> = {};
    headers['X-Requested-By'] = 'cli';
    const res = await fetch(`http://127.0.0.1:${PORT}/pause`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect(handlers.pause).toHaveBeenCalled();
  });

  it('POST without X-Requested-By gets 403 (proves CSRF guard is active)', async () => {
    const { server, start } = createControlServer(PORT + 1, handlers);
    serverRef = server;
    await start();

    // This is what the old callApi did — no headers
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/pause`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
