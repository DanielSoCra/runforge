import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerClaim } from './types.js';

let files: Map<string, WorkerClaim>;
let readdirMock: ReturnType<typeof vi.fn>;
let readJsonSafeMock: ReturnType<typeof vi.fn>;
let writeJsonSafeMock: ReturnType<typeof vi.fn>;

function cloneClaim(claim: WorkerClaim): WorkerClaim {
  return { ...claim };
}

async function createClaimer() {
  const { createWorkClaimer } = await import('./work-claimer.js');
  return createWorkClaimer('/state');
}

describe('work-claimer claim cache', () => {
  beforeEach(() => {
    vi.resetModules();
    files = new Map();
    readdirMock = vi.fn(async () => [...files.keys()].map(path => path.split('/').at(-1)!));
    readJsonSafeMock = vi.fn(async (path: string) => {
      const claim = files.get(path);
      return claim
        ? { ok: true, value: cloneClaim(claim) }
        : { ok: false, error: new Error(`missing ${path}`) };
    });
    writeJsonSafeMock = vi.fn(async (path: string, claim: WorkerClaim) => {
      files.set(path, cloneClaim(claim));
    });

    vi.doMock('fs/promises', () => ({
      mkdir: vi.fn(async () => undefined),
      readdir: readdirMock,
    }));
    vi.doMock('../lib/json-store.js', () => ({
      readJsonSafe: readJsonSafeMock,
      writeJsonSafe: writeJsonSafeMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.doUnmock('../lib/json-store.js');
  });

  it('reuses one directory scan across list and claim mutations in the same claimer instance', async () => {
    const claimer = await createClaimer();

    await claimer.listActive();
    const first = await claimer.claim(101, 'worker');
    const second = await claimer.claim(102, 'worker');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(readJsonSafeMock).toHaveBeenCalledTimes(0);
  });

  it('updates the cached claim after status changes without rescanning the directory', async () => {
    const claimer = await createClaimer();

    const claimed = await claimer.claim(201, 'worker');
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    const updated = await claimer.updateStatus(claimed.value.id, 'failed', 'spawn failed');
    const all = await claimer.listAll();

    expect(updated.ok).toBe(true);
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('failed');
    expect(all[0]!.failureReason).toBe('spawn failed');
  });
});
