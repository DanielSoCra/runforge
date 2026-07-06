// G3 gate: awaitRequiredChecks polls a ref's check-runs (and legacy combined
// status) against an EXPLICIT required-check-names list — green only when every
// named check succeeds, red on any named failure, timeout on budget exhaustion,
// and 'no-required-checks' on an empty list (the caller escalates that; never a
// silent green). Runtime lookup so the file typechecks at RED.
import { describe, expect, it, vi } from 'vitest';

const AWAIT_CHECKS_MODULE_PATH = './await-checks.js';

interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | null;
}

interface AwaitRequiredChecksArgs {
  octokit: unknown;
  owner: string;
  repo: string;
  ref: string;
  requiredChecks: string[];
  budgetMs?: number;
  pollMs?: number;
}

type AwaitRequiredChecksResult =
  | { status: 'green' }
  | { status: 'red'; reason?: string }
  | { status: 'timeout'; reason?: string }
  | { status: 'no-required-checks'; reason?: string };

type AwaitRequiredChecks = (args: AwaitRequiredChecksArgs) => Promise<AwaitRequiredChecksResult>;

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadAwaitRequiredChecks(): Promise<AwaitRequiredChecks> {
  let mod: Record<string, unknown> = {};
  try {
    mod = (await import(AWAIT_CHECKS_MODULE_PATH)) as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    mod = { __loadError: error };
  }
  const fn = mod.awaitRequiredChecks as AwaitRequiredChecks | undefined;
  expect(
    fn,
    `awaitRequiredChecks must be exported from ${AWAIT_CHECKS_MODULE_PATH}; load error: ${formatUnknownError(mod.__loadError)}`,
  ).toBeTypeOf('function');
  return fn!;
}

// A mock octokit whose check-runs response can vary per poll (sequence of frames),
// with the last frame repeating once exhausted.
function makeOctokit(frames: CheckRun[][]) {
  let i = 0;
  const listForRef = vi.fn(async () => {
    const frame = frames[Math.min(i, frames.length - 1)] ?? [];
    i += 1;
    return { data: { total_count: frame.length, check_runs: frame } };
  });
  return {
    checks: { listForRef },
    repos: {
      getCombinedStatusForRef: vi.fn(async () => ({ data: { state: 'success', statuses: [] } })),
    },
  };
}

const ok = (name: string): CheckRun => ({ name, status: 'completed', conclusion: 'success' });
const fail = (name: string): CheckRun => ({ name, status: 'completed', conclusion: 'failure' });
const pending = (name: string): CheckRun => ({ name, status: 'in_progress', conclusion: null });

describe('G3 awaitRequiredChecks', () => {
  it('returns green only when every NAMED required check has concluded success', async () => {
    const awaitRequiredChecks = await loadAwaitRequiredChecks();
    const octokit = makeOctokit([[ok('daemon / test'), ok('daemon / typecheck'), ok('unrelated')]]);

    const result = await awaitRequiredChecks({
      octokit,
      owner: 'o',
      repo: 'r',
      ref: 'feature/x',
      requiredChecks: ['daemon / test', 'daemon / typecheck'],
      budgetMs: 1000,
      pollMs: 10,
    });

    expect(result.status).toBe('green');
  });

  it('keeps polling while required checks are absent or pending instead of treating them as indeterminate', async () => {
    const awaitRequiredChecks = await loadAwaitRequiredChecks();
    const octokit = makeOctokit([
      [],
      [ok('daemon / test'), pending('daemon / typecheck')],
      [ok('daemon / test'), ok('daemon / typecheck')],
    ]);

    const result = await awaitRequiredChecks({
      octokit,
      owner: 'o',
      repo: 'r',
      ref: 'main-merge-sha',
      requiredChecks: ['daemon / test', 'daemon / typecheck'],
      budgetMs: 1000,
      pollMs: 1,
    });

    expect(result.status).toBe('green');
    expect(octokit.checks.listForRef).toHaveBeenCalledTimes(3);
  });

  it('returns red when any named required check fails', async () => {
    const awaitRequiredChecks = await loadAwaitRequiredChecks();
    const octokit = makeOctokit([[ok('daemon / test'), fail('daemon / typecheck')]]);

    const result = await awaitRequiredChecks({
      octokit,
      owner: 'o',
      repo: 'r',
      ref: 'feature/x',
      requiredChecks: ['daemon / test', 'daemon / typecheck'],
      budgetMs: 1000,
      pollMs: 10,
    });

    expect(result.status).toBe('red');
  });

  it('returns timeout when a named required check never concludes within the budget', async () => {
    const awaitRequiredChecks = await loadAwaitRequiredChecks();
    const octokit = makeOctokit([[ok('daemon / test'), pending('daemon / typecheck')]]);

    const result = await awaitRequiredChecks({
      octokit,
      owner: 'o',
      repo: 'r',
      ref: 'feature/x',
      requiredChecks: ['daemon / test', 'daemon / typecheck'],
      budgetMs: 60,
      pollMs: 15,
    });

    expect(result.status).toBe('timeout');
  });

  it('returns no-required-checks (never green) when the required list is empty', async () => {
    const awaitRequiredChecks = await loadAwaitRequiredChecks();
    const octokit = makeOctokit([[]]);

    const result = await awaitRequiredChecks({
      octokit,
      owner: 'o',
      repo: 'r',
      ref: 'feature/x',
      requiredChecks: [],
      budgetMs: 1000,
      pollMs: 10,
    });

    expect(result.status).toBe('no-required-checks');
    expect(result.status).not.toBe('green');
  });
});
