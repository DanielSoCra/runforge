import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createControlServer } from './server.js';
import { createCli } from './cli.js';
import { ok, err } from '../lib/result.js';
import type { Server } from 'http';

const PORT = 19877; // different from server.test.ts to avoid conflicts
let serverRef: Server | undefined;

const handlers = {
  getStatus: () => ({ activeRuns: 0, paused: false }),
  pause: vi.fn(),
  resume: vi.fn(),
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

async function startServer() {
  const { server, start } = createControlServer(PORT, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
}

beforeEach(async () => {
  process.exitCode = undefined;
  handlers.pause.mockClear();
  handlers.resume.mockClear();
  await startServer();
});

afterEach(() => {
  if (serverRef) { serverRef.close(); serverRef = undefined; }
});

describe('CLI commands send X-Requested-By header on POST', () => {
  it('pause command succeeds (not 403)', async () => {
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'pause', '-p', String(PORT)]);
    expect(handlers.pause).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('resume command succeeds (not 403)', async () => {
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'resume', '-p', String(PORT)]);
    expect(handlers.resume).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('retry command succeeds (not 403)', async () => {
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'retry', '42', '-p', String(PORT)]);
    expect(process.exitCode).toBeUndefined();
  });

  it('status command (GET) succeeds without header', async () => {
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'status', '-p', String(PORT)]);
    expect(process.exitCode).toBeUndefined();
  });
});
