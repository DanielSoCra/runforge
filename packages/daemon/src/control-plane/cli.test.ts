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
  drain: vi.fn(),
  cancelDrain: vi.fn(),
  retry: (n: number) => n === 42 ? ok(undefined) : err(new Error('not found')),
};

async function startServer() {
  const { server, start } = createControlServer(PORT, handlers);
  serverRef = server;
  const result = await start();
  expect(result.ok).toBe(true);
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (serverRef) {
      serverRef.close(() => resolve());
      serverRef = undefined;
    } else {
      resolve();
    }
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  handlers.pause.mockClear();
  handlers.resume.mockClear();
  await startServer();
});

afterEach(async () => {
  await stopServer();
});

describe('createCli', () => {
  it('returns a Commander program with correct name and version', () => {
    const cli = createCli();
    expect(cli.name()).toBe('auto-claude');
    expect(cli.version()).toBe('0.1.0');
  });
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

describe('status command', () => {
  it('outputs JSON from /status endpoint', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'status', '-p', String(PORT)]);
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ activeRuns: 0, paused: false }, null, 2));
    expect(process.exitCode).toBeUndefined();
    spy.mockRestore();
  });
});

describe('health command', () => {
  it('outputs JSON from /health endpoint', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'health', '-p', String(PORT)]);
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, degraded: false, lastConfigError: null }, null, 2),
    );
    expect(process.exitCode).toBeUndefined();
    spy.mockRestore();
  });
});

describe('retry command', () => {
  it('sets exitCode on retry failure (issue not found)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'retry', '999', '-p', String(PORT)]);
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
  });

  it('succeeds when issue exists', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'retry', '42', '-p', String(PORT)]);
    expect(process.exitCode).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ retrying: 42 }, null, 2));
    spy.mockRestore();
  });
});

describe('connection failure handling', () => {
  it('sets exitCode and logs error when daemon is not running', async () => {
    await stopServer();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'status', '-p', String(PORT)]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to connect to daemon on port ${PORT}`),
    );
    errSpy.mockRestore();
  });

  it('connection failure works for POST commands too', async () => {
    await stopServer();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'pause', '-p', String(PORT)]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to connect to daemon on port ${PORT}`),
    );
    errSpy.mockRestore();
  });
});

describe('default port', () => {
  it('uses port 3847 by default when no -p flag', () => {
    const cli = createCli();
    const statusCmd = cli.commands.find((c) => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    const portOpt = statusCmd!.opts();
    // Commander stores the default; we just verify it parses without -p
    expect(portOpt.port).toBe('3847');
  });
});

describe('command registration', () => {
  it('registers all 6 expected commands', () => {
    const cli = createCli();
    const names = cli.commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining(['start', 'status', 'pause', 'resume', 'retry', 'health']),
    );
    expect(names).toHaveLength(6);
  });

  it('start command has --config option defaulting to auto-claude.config.json', () => {
    const cli = createCli();
    const startCmd = cli.commands.find((c) => c.name() === 'start')!;
    const configOpt = startCmd.options.find((o) => o.long === '--config');
    expect(configOpt).toBeDefined();
    expect(configOpt!.defaultValue).toBe('auto-claude.config.json');
  });
});

describe('pause command output', () => {
  it('outputs paused:true JSON', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'pause', '-p', String(PORT)]);
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ paused: true }, null, 2));
    spy.mockRestore();
  });
});

describe('resume command output', () => {
  it('outputs paused:false JSON', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'resume', '-p', String(PORT)]);
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ paused: false }, null, 2));
    spy.mockRestore();
  });
});

describe('start command', () => {
  it('logs startup message with config path', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'start', '-c', 'custom.json']);
    expect(spy).toHaveBeenCalledWith('Starting daemon with config: custom.json');
    spy.mockRestore();
  });

  it('uses default config path when none specified', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = createCli();
    await cli.parseAsync(['node', 'auto-claude', 'start']);
    expect(spy).toHaveBeenCalledWith('Starting daemon with config: auto-claude.config.json');
    spy.mockRestore();
  });
});
