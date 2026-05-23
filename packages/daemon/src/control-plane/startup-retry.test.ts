import { afterEach, describe, expect, it, vi } from 'vitest';

import { err, ok, type Result } from '../lib/result.js';
import {
  readStartupRetryOptions,
  runStartupRetry,
  type RetryFailure,
  type StartupRetryOptions,
} from './startup-retry.js';

function unreachable(code = 'ECONNREFUSED'): RetryFailure {
  return {
    category: 'unreachable',
    cause: { class: 'Error', code, message: 'connect refused' },
  };
}

function rejected(code = '28P01'): RetryFailure {
  return {
    category: 'rejected',
    cause: { class: 'Error', code, message: 'auth failed' },
  };
}

/**
 * Build a tryFetch that returns the given sequence of outcomes in order
 * (`null` = success), recording how many delays were requested.
 */
function makeRetry(sequence: (RetryFailure | null)[]) {
  let i = 0;
  const tryFetch = (): Promise<Result<void, RetryFailure>> => {
    const outcome = sequence[i] ?? null;
    i += 1;
    return Promise.resolve(outcome === null ? ok(undefined) : err(outcome));
  };
  const delays: number[] = [];
  const delay = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { tryFetch, delays, delay, attempts: () => i };
}

const baseOptions: Omit<StartupRetryOptions, 'delay'> = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
};

describe('runStartupRetry', () => {
  it('succeeds on the first attempt with no delays', async () => {
    const { tryFetch, delays, delay, attempts } = makeRetry([null]);
    const result = await runStartupRetry(
      tryFetch,
      { ...baseOptions, delay },
      () => {},
    );
    expect(result.kind).toBe('success');
    expect(attempts()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries unreachable 3 times then succeeds (4 attempts, delays 1000/2000/4000)', async () => {
    const { tryFetch, delays, delay, attempts } = makeRetry([
      unreachable(),
      unreachable(),
      unreachable(),
      null,
    ]);
    const result = await runStartupRetry(
      tryFetch,
      { ...baseOptions, delay },
      () => {},
    );
    expect(result.kind).toBe('success');
    expect(attempts()).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('exhausts after maxAttempts unreachable failures (no delay after final attempt)', async () => {
    const { tryFetch, delays, delay, attempts } = makeRetry([
      unreachable(),
      unreachable(),
      unreachable(),
      unreachable(),
      unreachable(),
    ]);
    const result = await runStartupRetry(
      tryFetch,
      { ...baseOptions, delay },
      () => {},
    );
    expect(result.kind).toBe('exhausted');
    if (result.kind !== 'exhausted') throw new Error('expected exhausted');
    expect(result.lastFailure.category).toBe('unreachable');
    expect(attempts()).toBe(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('short-circuits on a rejected outcome at attempt 1 (no delays)', async () => {
    const { tryFetch, delays, delay, attempts } = makeRetry([rejected()]);
    const result = await runStartupRetry(
      tryFetch,
      { ...baseOptions, delay },
      () => {},
    );
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('expected rejected');
    expect(result.failure.cause.code).toBe('28P01');
    expect(attempts()).toBe(1);
    expect(delays).toEqual([]);
  });

  it('caps backoff at maxDelayMs', async () => {
    const { tryFetch, delays, delay } = makeRetry([
      unreachable(),
      unreachable(),
      unreachable(),
      unreachable(),
      unreachable(),
      null,
    ]);
    const result = await runStartupRetry(
      tryFetch,
      {
        maxAttempts: 6,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        delay,
      },
      () => {},
    );
    expect(result.kind).toBe('success');
    expect(delays).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it('invokes onAttempt for each outcome', async () => {
    const { tryFetch, delay } = makeRetry([unreachable(), null]);
    const seen: string[] = [];
    await runStartupRetry(
      tryFetch,
      { ...baseOptions, delay },
      (a) => seen.push('outcome' in a ? a.outcome : a.category),
    );
    expect(seen).toEqual(['unreachable', 'ok']);
  });
});

describe('readStartupRetryOptions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid env values', () => {
    const opts = readStartupRetryOptions({
      DAEMON_STARTUP_RETRY_MAX_ATTEMPTS: '3',
      DAEMON_STARTUP_RETRY_BASE_MS: '500',
      DAEMON_STARTUP_RETRY_MAX_DELAY_MS: '8000',
    } as NodeJS.ProcessEnv);
    expect(opts).toEqual({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
    });
  });

  it('falls back to defaults for missing env', () => {
    const opts = readStartupRetryOptions({} as NodeJS.ProcessEnv);
    expect(opts).toEqual({
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 16000,
    });
  });

  it('falls back and warns on garbage values, never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = readStartupRetryOptions({
      DAEMON_STARTUP_RETRY_MAX_ATTEMPTS: 'banana',
      DAEMON_STARTUP_RETRY_BASE_MS: '-5',
      DAEMON_STARTUP_RETRY_MAX_DELAY_MS: '0',
    } as NodeJS.ProcessEnv);
    expect(opts).toEqual({
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 16000,
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
