import { describe, it, expect, vi } from 'vitest';
import { ok, err, type Result } from '../lib/result.js';
import {
  evaluateWatchdog,
  createWatchdog,
  readActiveRunProgress,
  type WatchdogSignals,
  type WatchdogStall,
} from './watchdog.js';

const IDLE = 60_000;

function signals(over: Partial<WatchdogSignals> = {}): WatchdogSignals {
  return {
    activeRunProgress: over.activeRunProgress ?? [],
    pollerSnapshots: over.pollerSnapshots ?? [],
  };
}

describe('evaluateWatchdog', () => {
  it('flags a run-stall when an active run has not progressed past idle-timeout', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({
        activeRunProgress: [{ issue: 7, lastUpdatedAt: now - IDLE - 1 }],
      }),
      now,
      IDLE,
    );
    expect(stall).not.toBeNull();
    expect(stall?.kind).toBe('run-stall');
    expect(stall?.detail).toContain('#7');
  });

  it('does NOT flag a run still progressing (lastUpdatedAt within idle-timeout)', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({
        activeRunProgress: [{ issue: 7, lastUpdatedAt: now - 1000 }],
      }),
      now,
      IDLE,
    );
    expect(stall).toBeNull();
  });

  it('does NOT flag a run exactly at the idle-timeout boundary (strictly-greater detection)', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({
        activeRunProgress: [{ issue: 7, lastUpdatedAt: now - IDLE }],
      }),
      now,
      IDLE,
    );
    expect(stall).toBeNull();
  });

  it('does NOT flag a run whose progress timestamp is unknown (null lastUpdatedAt)', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({ activeRunProgress: [{ issue: 7, lastUpdatedAt: null }] }),
      now,
      IDLE,
    );
    expect(stall).toBeNull();
  });

  it('flags a tick-stall when a poll started but never settled past idle-timeout', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({
        pollerSnapshots: [
          {
            repoId: 'r1',
            owner: 'acme',
            name: 'web',
            pollInProgress: true,
            pollStartedAt: now - IDLE - 1,
          },
        ],
      }),
      now,
      IDLE,
    );
    expect(stall?.kind).toBe('tick-stall');
    expect(stall?.detail).toContain('r1');
  });

  it('does NOT flag a tick-stall when the poll is not in progress', () => {
    const now = 1_000_000;
    const stall = evaluateWatchdog(
      signals({
        pollerSnapshots: [
          {
            repoId: 'r1',
            owner: 'acme',
            name: 'web',
            pollInProgress: false,
            pollStartedAt: null,
          },
        ],
      }),
      now,
      IDLE,
    );
    expect(stall).toBeNull();
  });

  it('returns null when there is nothing active', () => {
    expect(evaluateWatchdog(signals(), 1_000_000, IDLE)).toBeNull();
  });
});

describe('createWatchdog', () => {
  function deps(over: {
    signals?: WatchdogSignals;
    paused?: boolean;
    shuttingDown?: boolean;
    now?: number;
  } = {}) {
    let paused = over.paused ?? false;
    const onStall = vi.fn<(s: WatchdogStall) => void>(() => {
      paused = true; // mirror the daemon: a stall self-pauses
    });
    const readSignals = vi.fn(async () => over.signals ?? signals());
    const wd = createWatchdog({
      now: () => over.now ?? 1_000_000,
      idleTimeoutMs: IDLE,
      readSignals,
      isPaused: () => paused,
      isShuttingDown: () => over.shuttingDown ?? false,
      onStall,
    });
    return { wd, onStall, readSignals, isPaused: () => paused };
  }

  it('calls onStall once on a run-stall, then stays quiet because the daemon self-paused', async () => {
    const now = 1_000_000;
    const { wd, onStall } = deps({
      now,
      signals: signals({
        activeRunProgress: [{ issue: 9, lastUpdatedAt: now - IDLE - 5 }],
      }),
    });

    await wd.tick();
    await wd.tick(); // second tick: isPaused() now true → short-circuits

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]![0].kind).toBe('run-stall');
  });

  it('does nothing when already paused (no double-fire)', async () => {
    const now = 1_000_000;
    const { wd, onStall, readSignals } = deps({
      now,
      paused: true,
      signals: signals({
        activeRunProgress: [{ issue: 9, lastUpdatedAt: now - IDLE - 5 }],
      }),
    });
    await wd.tick();
    expect(onStall).not.toHaveBeenCalled();
    expect(readSignals).not.toHaveBeenCalled();
  });

  it('does nothing when shutting down', async () => {
    const now = 1_000_000;
    const { wd, onStall } = deps({
      now,
      shuttingDown: true,
      signals: signals({
        activeRunProgress: [{ issue: 9, lastUpdatedAt: now - IDLE - 5 }],
      }),
    });
    await wd.tick();
    expect(onStall).not.toHaveBeenCalled();
  });

  it('does not flag a progressing run', async () => {
    const now = 1_000_000;
    const { wd, onStall } = deps({
      now,
      signals: signals({
        activeRunProgress: [{ issue: 9, lastUpdatedAt: now - 10 }],
      }),
    });
    await wd.tick();
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe('readActiveRunProgress', () => {
  function loaderFrom(
    map: Record<number, string | undefined>,
  ): (issue: number) => Promise<Result<{ updatedAt?: string }>> {
    return async (issue: number) => {
      const v = map[issue];
      if (v === undefined) return err(new Error('not found'));
      return ok({ updatedAt: v });
    };
  }

  it('reads each active issue persisted updatedAt as epoch-ms', async () => {
    const loader = loaderFrom({
      1: '2026-06-26T00:00:00.000Z',
      2: '2026-06-26T01:00:00.000Z',
    });
    const out = await readActiveRunProgress([1, 2], loader);
    expect(out).toEqual([
      { issue: 1, lastUpdatedAt: Date.parse('2026-06-26T00:00:00.000Z') },
      { issue: 2, lastUpdatedAt: Date.parse('2026-06-26T01:00:00.000Z') },
    ]);
  });

  it('advances the timestamp as saveRunState advances updatedAt', async () => {
    let stamp = '2026-06-26T00:00:00.000Z';
    const loader: (i: number) => Promise<Result<{ updatedAt?: string }>> =
      async () => ok({ updatedAt: stamp });
    const first = await readActiveRunProgress([5], loader);
    stamp = '2026-06-26T02:30:00.000Z';
    const second = await readActiveRunProgress([5], loader);
    expect(second[0]!.lastUpdatedAt!).toBeGreaterThan(first[0]!.lastUpdatedAt!);
  });

  it('reports null lastUpdatedAt when the run state cannot be loaded', async () => {
    const out = await readActiveRunProgress([42], loaderFrom({}));
    expect(out).toEqual([{ issue: 42, lastUpdatedAt: null }]);
  });

  it('reports null lastUpdatedAt for an unparseable updatedAt', async () => {
    const out = await readActiveRunProgress([1], loaderFrom({ 1: 'not-a-date' }));
    expect(out).toEqual([{ issue: 1, lastUpdatedAt: null }]);
  });
});
