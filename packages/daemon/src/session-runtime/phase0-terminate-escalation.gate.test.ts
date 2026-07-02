import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __clearManagedProcessesForTests,
  managedProcessCount,
  registerManagedProcess,
} from './managed-processes.js';

const spawned = new Set<ChildProcess>();

// `terminateAllManagedProcessGroups` does not exist yet (Task 5) — a static
// named import would make this file fail typecheck rather than fail RED at
// runtime. Looked up dynamically so the gate typechecks pre-implementation
// and still fails for the intended behavioral reason (undefined function).
type TerminateAllManagedProcessGroups = (opts?: {
  graceMs?: number;
}) => Promise<{ terminated: number; escalated: number }>;

let terminateAllManagedProcessGroups: TerminateAllManagedProcessGroups | undefined;

beforeEach(async () => {
  __clearManagedProcessesForTests();
  const mod = (await import('./managed-processes.js')) as Record<string, unknown>;
  terminateAllManagedProcessGroups = mod.terminateAllManagedProcessGroups as
    | TerminateAllManagedProcessGroups
    | undefined;
  expect(
    terminateAllManagedProcessGroups,
    'terminateAllManagedProcessGroups must be exported by managed-processes (Task 5)',
  ).toBeTypeOf('function');
});

afterEach(async () => {
  await Promise.all(
    [...spawned].map(async (child) => {
      killProcessGroupBestEffort(child);
      await waitForExit(child, 2_000).catch(() => {});
    }),
  );
  __clearManagedProcessesForTests();
});

describe('phase0 G5 terminateAllManagedProcessGroups', () => {
  it('SIGTERMs a managed process group and reports graceful termination', async () => {
    const child = await spawnManagedNode(`
process.on('SIGTERM', () => {
  setTimeout(() => process.exit(0), 25);
});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

    expect(managedProcessCount()).toBe(1);

    const result = await terminateAllManagedProcessGroups!({ graceMs: 200 });
    await waitForExit(child);

    expect(result).toEqual({ terminated: 1, escalated: 0 });
    expect(child.exitCode).toBe(0);
    expect(managedProcessCount()).toBe(0);
  });

  it('SIGKILLs a managed process group that survives the SIGTERM grace period', async () => {
    const child = await spawnManagedNode(`
process.on('SIGTERM', () => {
  process.stdout.write('ignored\\n');
});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

    expect(managedProcessCount()).toBe(1);

    const result = await terminateAllManagedProcessGroups!({ graceMs: 200 });
    await waitForExit(child);

    expect(result).toEqual({ terminated: 0, escalated: 1 });
    expect(child.signalCode).toBe('SIGKILL');
    expect(managedProcessCount()).toBe(0);
  });

  it('is idempotent when the registry is already empty', async () => {
    await expect(
      terminateAllManagedProcessGroups!({ graceMs: 10 }),
    ).resolves.toEqual({ terminated: 0, escalated: 0 });
    expect(managedProcessCount()).toBe(0);
  });
});

function spawnManagedNode(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  child.once('error', () => spawned.delete(child));

  return new Promise((resolve, reject) => {
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onEarlyExit);
    };
    const onData = (chunk: unknown) => {
      output += String(chunk);
      if (output.includes('ready')) {
        cleanup();
        registerManagedProcess(child);
        resolve(child);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEarlyExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      cleanup();
      reject(new Error(`child exited before ready: code=${code} signal=${signal}`));
    };

    timer = setTimeout(() => {
      cleanup();
      killProcessGroupBestEffort(child);
      reject(new Error('child did not become ready'));
    }, 5_000);

    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onEarlyExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('child did not exit'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function killProcessGroupBestEffort(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}
