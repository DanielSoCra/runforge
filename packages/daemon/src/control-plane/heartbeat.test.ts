// src/control-plane/heartbeat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { startHeartbeat } from './heartbeat.js';

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes heartbeat file immediately on start', async () => {
    const stop = startHeartbeat('/tmp/test.heartbeat', 30_000);
    // Flush the immediate write
    await vi.advanceTimersByTimeAsync(0);

    expect(mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/test.heartbeat',
      expect.stringContaining('2026-03-24'),
    );

    stop();
  });

  it('writes heartbeat on each interval tick', async () => {
    const stop = startHeartbeat('/tmp/test.heartbeat', 30_000);
    await vi.advanceTimersByTimeAsync(0);

    vi.mocked(writeFile).mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeFile).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() clears the interval', async () => {
    const stop = startHeartbeat('/tmp/test.heartbeat', 30_000);
    await vi.advanceTimersByTimeAsync(0);

    vi.mocked(writeFile).mockClear();
    stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('logs warning on write failure without throwing', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = startHeartbeat('/tmp/test.heartbeat', 30_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[heartbeat]'),
      expect.any(Error),
    );

    stop();
  });
});
