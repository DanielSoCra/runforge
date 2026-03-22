import { describe, it, expect, vi } from 'vitest';
import { dispatchWithFallback, handleResult, computeBackoffMs } from './dispatch.js';
import type { PipelineRunState } from './dispatch.js';
import type { DispatchRequest, DispatchResult } from './session-types.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';
import { SessionError } from '../session-runtime/session-error.js';

function makeRequest(overrides?: Partial<DispatchRequest>): DispatchRequest {
  return {
    sessionType: 'implementation',
    context: { issueNumber: 42, repo: 'DANIELSOCRAHANDLEZZ/auto-claude' },
    baseBranch: 'dev',
    ...overrides,
  };
}

function makeSessionResult(overrides?: Partial<SessionResult>): SessionResult {
  return {
    output: 'Implementation complete',
    structuredData: null,
    cost: 1.5,
    pitfallMarkers: [],
    exitStatus: 'completed',
    ...overrides,
  };
}

function makeMockRuntime(responses: Array<ReturnType<typeof ok | typeof err>>): SessionRuntime {
  let callCount = 0;
  return {
    spawnSession: vi.fn(async () => {
      const response = responses[callCount] ?? responses[responses.length - 1];
      callCount++;
      return response;
    }),
  } as unknown as SessionRuntime;
}

function makeRunState(overrides?: Partial<PipelineRunState>): PipelineRunState {
  return { failCount: 0, sleepUntil: 0, ...overrides };
}

describe('dispatchWithFallback', () => {
  it('returns completed status on successful session', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult())]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('completed');
    expect(result.costIncurred).toBe(1.5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain('Implementation complete');
  });

  it('maps completed-with-concerns to completed', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult({ exitStatus: 'completed-with-concerns' }))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('completed');
  });

  it('maps blocked exit status to failed', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult({ exitStatus: 'blocked' }))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('failed');
  });

  it('maps timed-out exit status to timed-out', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult({ exitStatus: 'timed-out' }))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('timed-out');
  });

  it('returns budget-exceeded when SessionError indicates budget exceeded', async () => {
    const runtime = makeMockRuntime([err(SessionError.budgetExceeded('daily limit reached'))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('budget-exceeded');
    expect(result.summary).toContain('Budget exceeded');
  });

  it('returns rate-limited when SessionError indicates rate limiting', async () => {
    const runtime = makeMockRuntime([err(SessionError.rateLimited(0.5, 30_000))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('rate-limited');
    expect(result.cooldownMs).toBe(30_000);
  });

  it('returns failed on containment breach', async () => {
    const runtime = makeMockRuntime([err(SessionError.containmentBreached('wrote to /etc', 0.1))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Containment breach');
  });

  it('returns failed on generic session error', async () => {
    const runtime = makeMockRuntime([err(new Error('something broke'))]);
    const result = await dispatchWithFallback(makeRequest(), runtime);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('something broke');
  });

  it('returns failed on unexpected (non-connection) throw', async () => {
    const runtime = {
      spawnSession: vi.fn(async () => { throw new Error('unexpected crash'); }),
    } as unknown as SessionRuntime;

    const result = await dispatchWithFallback(makeRequest(), runtime);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Unexpected error');
  });

  it('passes correct agentDef to spawnSession', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult())]);
    await dispatchWithFallback(makeRequest({ sessionType: 'l2-brainstorm' }), runtime);

    const spawnCall = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(spawnCall[3].agentDef.name).toBe('l2-designer');
  });

  it('includes feedback in context variables when provided', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult())]);
    await dispatchWithFallback(
      makeRequest({ context: { issueNumber: 42, repo: 'test/repo', feedback: 'fix the arch diagram' } }),
      runtime,
    );

    const spawnCall = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const context = spawnCall[1];
    expect(context.variables.feedback).toBe('fix the arch diagram');
  });

  it('does not include feedback key when feedback is absent', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult())]);
    await dispatchWithFallback(makeRequest(), runtime);

    const spawnCall = (runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const context = spawnCall[1];
    expect(context.variables).not.toHaveProperty('feedback');
  });
});

describe('handleResult', () => {
  it('resets failCount on completed', () => {
    const state = makeRunState({ failCount: 3 });
    handleResult({ status: 'completed', costIncurred: 1, durationMs: 100, summary: 'ok' }, state);
    expect(state.failCount).toBe(0);
  });

  it('increments failCount on failed', () => {
    const state = makeRunState({ failCount: 1 });
    handleResult({ status: 'failed', costIncurred: 0, durationMs: 100, summary: 'err' }, state);
    expect(state.failCount).toBe(2);
  });

  it('increments failCount on timed-out', () => {
    const state = makeRunState();
    handleResult({ status: 'timed-out', costIncurred: 0, durationMs: 100, summary: 'timeout' }, state);
    expect(state.failCount).toBe(1);
  });

  it('sets sleepUntil on budget-exceeded', () => {
    const state = makeRunState();
    const before = Date.now();
    handleResult({ status: 'budget-exceeded', costIncurred: 0, durationMs: 100, summary: 'budget' }, state);
    // Should sleep until midnight UTC
    expect(state.sleepUntil).toBeGreaterThan(before);
  });

  it('sets sleepUntil on rate-limited with cooldownMs', () => {
    const state = makeRunState();
    const before = Date.now();
    handleResult(
      { status: 'rate-limited', costIncurred: 0, durationMs: 100, summary: 'rate', cooldownMs: 30_000 },
      state,
    );
    expect(state.sleepUntil).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('uses default 60s cooldown when cooldownMs is absent for rate-limited', () => {
    const state = makeRunState();
    const before = Date.now();
    handleResult(
      { status: 'rate-limited', costIncurred: 0, durationMs: 100, summary: 'rate' },
      state,
    );
    expect(state.sleepUntil).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('throws on unknown status (exhaustive check)', () => {
    const state = makeRunState();
    expect(() =>
      handleResult(
        { status: 'unknown' as DispatchResult['status'], costIncurred: 0, durationMs: 0, summary: '' },
        state,
      ),
    ).toThrow('Unhandled dispatch status');
  });
});

describe('computeBackoffMs', () => {
  it('returns 0 when no failures and no sleep', () => {
    const state = makeRunState();
    expect(computeBackoffMs(state)).toBe(0);
  });

  it('returns remaining sleep time when sleepUntil is in the future', () => {
    const state = makeRunState({ sleepUntil: Date.now() + 10_000 });
    const backoff = computeBackoffMs(state);
    expect(backoff).toBeGreaterThan(9_000);
    expect(backoff).toBeLessThanOrEqual(10_000);
  });

  it('returns exponential backoff based on failCount', () => {
    expect(computeBackoffMs(makeRunState({ failCount: 1 }))).toBe(60_000);
    expect(computeBackoffMs(makeRunState({ failCount: 2 }))).toBe(120_000);
    expect(computeBackoffMs(makeRunState({ failCount: 3 }))).toBe(240_000);
  });

  it('caps backoff at 3600 seconds', () => {
    const state = makeRunState({ failCount: 10 });
    expect(computeBackoffMs(state)).toBe(3_600_000);
  });

  it('resets sleepUntil when it is in the past', () => {
    const state = makeRunState({ sleepUntil: Date.now() - 1000 });
    computeBackoffMs(state);
    expect(state.sleepUntil).toBe(0);
  });
});
