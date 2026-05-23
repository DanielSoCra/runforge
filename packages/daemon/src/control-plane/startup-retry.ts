import { type Result } from '../lib/result.js';

export interface StartupRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  delay?: (ms: number) => Promise<void>;
}

export interface RetryFailure {
  category: 'unreachable' | 'rejected';
  cause: { class: string; code: string | null; message: string };
}

export type StartupRetryResult =
  | { kind: 'success' }
  | { kind: 'rejected'; failure: RetryFailure }
  | { kind: 'exhausted'; lastFailure: RetryFailure };

export type StartupRetryAttempt =
  | { attempt: number; total: number; outcome: 'ok' }
  | ({ attempt: number; total: number } & RetryFailure);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a bounded retry of `tryFetch` with exponential backoff.
 *
 * - `success` → return immediately.
 * - `rejected` → return immediately (permanent misconfiguration: never retried).
 * - `unreachable` → invoke `onAttempt`, delay, retry. No delay after the final
 *   attempt. After `maxAttempts` unreachable failures → `exhausted`.
 *
 * `delay` is injectable so tests do not wait on real timers.
 */
export async function runStartupRetry(
  tryFetch: () => Promise<Result<void, RetryFailure>>,
  options: StartupRetryOptions,
  onAttempt: (attempt: StartupRetryAttempt) => void,
): Promise<StartupRetryResult> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = options;
  const delay = options.delay ?? defaultDelay;

  let lastFailure: RetryFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await tryFetch();

    if (result.ok) {
      onAttempt({ attempt, total: maxAttempts, outcome: 'ok' });
      return { kind: 'success' };
    }

    const failure = result.error;
    onAttempt({ attempt, total: maxAttempts, ...failure });

    if (failure.category === 'rejected') {
      return { kind: 'rejected', failure };
    }

    lastFailure = failure;

    // Unreachable → back off and retry, but never delay after the final attempt.
    if (attempt < maxAttempts) {
      const backoff = Math.min(
        baseDelayMs * 2 ** (attempt - 1),
        maxDelayMs,
      );
      await delay(backoff);
    }
  }

  return {
    kind: 'exhausted',
    lastFailure: lastFailure ?? {
      category: 'unreachable',
      cause: { class: 'Unknown', code: null, message: 'no failure recorded' },
    },
  };
}

/**
 * Parse the startup-retry tunables from the environment. Garbage values fall
 * back to defaults with a `console.warn`; this never throws.
 */
export function readStartupRetryOptions(
  env: NodeJS.ProcessEnv,
): StartupRetryOptions {
  return {
    maxAttempts: parsePositiveInt(
      env.DAEMON_STARTUP_RETRY_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      'DAEMON_STARTUP_RETRY_MAX_ATTEMPTS',
    ),
    baseDelayMs: parsePositiveInt(
      env.DAEMON_STARTUP_RETRY_BASE_MS,
      DEFAULT_BASE_MS,
      'DAEMON_STARTUP_RETRY_BASE_MS',
    ),
    maxDelayMs: parsePositiveInt(
      env.DAEMON_STARTUP_RETRY_MAX_DELAY_MS,
      DEFAULT_MAX_DELAY_MS,
      'DAEMON_STARTUP_RETRY_MAX_DELAY_MS',
    ),
  };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return value;
  }
  console.warn(
    `[daemon] invalid ${name}=${raw}; falling back to ${fallback}`,
  );
  return fallback;
}
