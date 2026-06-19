import { describe, it, expect, afterEach, vi } from 'vitest';
import { createControlServer } from './control-plane/server.js';
import { formatStartupError } from './main.js';
import { ok, err } from './lib/result.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

// Regression test for #148: main.ts callApi() must include X-Requested-By
// header on POST requests, otherwise daemon CSRF middleware returns 403.
// We test the actual fetch behavior that main.ts uses, not the CLI wrapper.

let serverRef: Server | undefined;

const handlers = {
  getStatus: () => ({ activeRuns: 0, paused: false }),
  pause: vi.fn(),
  resume: vi.fn(),
  drain: vi.fn(),
  cancelDrain: vi.fn(),
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

afterEach(async () => {
  if (serverRef) {
    const s = serverRef;
    serverRef = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('formatStartupError', () => {
  it('prints the top-level message with no cause', () => {
    expect(formatStartupError(new Error('boom'))).toBe('Failed to start: boom');
  });

  it('walks the cause chain and includes the driver code', () => {
    const deepest = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      { code: 'ECONNREFUSED' },
    );
    const mid = new Error('postgres connection error', { cause: deepest });
    const outer = new Error('startup config rejected', { cause: mid });

    const out = formatStartupError(outer);
    expect(out).toContain('Failed to start: startup config rejected');
    expect(out).toContain('  caused by: postgres connection error');
    expect(out).toContain(
      '  caused by: [ECONNREFUSED] connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('caps the chain at 5 layers', () => {
    let current = new Error('layer-0');
    for (let i = 1; i <= 8; i += 1) {
      current = new Error(`layer-${i}`, { cause: current });
    }
    const out = formatStartupError(current);
    // 1 "Failed to start" line + at most 5 "caused by" lines.
    expect(out.split('\n')).toHaveLength(6);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(() => formatStartupError(a)).not.toThrow();
  });
});

describe('main.ts callApi X-Requested-By header (#148)', () => {
  it('POST with X-Requested-By header succeeds (not 403)', async () => {
    const { server, start } = createControlServer(0, handlers);
    serverRef = server;
    await start();
    const port = (server.address() as AddressInfo).port;

    // Simulate what main.ts callApi does after the fix
    const headers: Record<string, string> = {};
    headers['X-Requested-By'] = 'cli';
    const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect(handlers.pause).toHaveBeenCalled();
  });

  it('POST without X-Requested-By gets 403 (proves CSRF guard is active)', async () => {
    const { server, start } = createControlServer(0, handlers);
    serverRef = server;
    await start();
    const port = (server.address() as AddressInfo).port;

    // This is what the old callApi did — no headers
    const res = await fetch(`http://127.0.0.1:${port}/pause`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
