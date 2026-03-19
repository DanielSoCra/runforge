import { describe, it, expect, vi } from 'vitest';
import { diagnose } from './diagnostician.js';
import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';

const validDiagnosis = {
  type: 'A' as const,
  confidence: 0.9,
  affectedSpecs: ['STACK-AC-DIAGNOSIS'],
  affectedArtifacts: [],
  suggestedAction: 'Fix the code',
  reasoning: 'Clearly a code bug',
};

const invalidDiagnosis = {
  type: 'X', // invalid type
  confidence: 0.9,
  affectedSpecs: ['STACK-AC-DIAGNOSIS'],
  affectedArtifacts: [],
  suggestedAction: 'Fix',
  reasoning: 'Bad',
};

function makeSessionResult(structuredData: unknown): SessionResult {
  return {
    output: 'some output',
    structuredData,
    cost: 0.01,
    pitfallMarkers: [],
    exitStatus: 'completed',
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

describe('diagnose', () => {
  it('returns parsed diagnosis when first attempt produces valid output', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult(validDiagnosis))]);

    const result = await diagnose(
      runtime,
      42,
      'Bug report',
      'implementation content',
      'spec content',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('A');
      expect(result.value.confidence).toBe(0.9);
    }
    expect((runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('retries once when first attempt produces invalid output and second succeeds', async () => {
    const runtime = makeMockRuntime([
      ok(makeSessionResult(invalidDiagnosis)),
      ok(makeSessionResult(validDiagnosis)),
    ]);

    const result = await diagnose(
      runtime,
      42,
      'Bug report',
      'implementation content',
      'spec content',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe('A');
    }
    expect((runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('returns error after two failures (both produce invalid output)', async () => {
    const runtime = makeMockRuntime([
      ok(makeSessionResult(invalidDiagnosis)),
      ok(makeSessionResult(invalidDiagnosis)),
    ]);

    const result = await diagnose(
      runtime,
      42,
      'Bug report',
      'implementation content',
      'spec content',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Diagnosis produced invalid output after retry');
    }
    expect((runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('returns error immediately if first spawnSession call fails', async () => {
    const runtimeError = new Error('Session failed');
    const runtime = makeMockRuntime([err(runtimeError)]);

    const result = await diagnose(
      runtime,
      42,
      'Bug report',
      'implementation content',
      'spec content',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(runtimeError);
    }
    expect((runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('returns error if retry spawnSession call fails', async () => {
    const retryError = new Error('Retry session failed');
    const runtime = makeMockRuntime([
      ok(makeSessionResult(invalidDiagnosis)),
      err(retryError),
    ]);

    const result = await diagnose(
      runtime,
      42,
      'Bug report',
      'implementation content',
      'spec content',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(retryError);
    }
    expect((runtime.spawnSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('passes correct context variables to spawnSession', async () => {
    const runtime = makeMockRuntime([ok(makeSessionResult(validDiagnosis))]);

    await diagnose(runtime, 99, 'my bug report', 'my implementation', 'my specs');

    const spawnMock = runtime.spawnSession as ReturnType<typeof vi.fn>;
    const [sessionType, context, issueNumber] = spawnMock.mock.calls[0] as [
      string,
      { variables: Record<string, string> },
      number,
    ];
    expect(sessionType).toBe('diagnostician');
    expect(issueNumber).toBe(99);
    expect(context.variables.bugReport).toBe('my bug report');
    expect(context.variables.implementation).toBe('my implementation');
    expect(context.variables.specs).toBe('my specs');
  });
});
