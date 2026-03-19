// src/implementation/decompose.test.ts
import { describe, it, expect, vi } from 'vitest';
import { decompose } from './decompose.js';
import type { WorkRequest, SessionResult } from '../types.js';
import { ok, err } from '../lib/result.js';

const mockWorkRequest: WorkRequest = {
  issueNumber: 7,
  title: 'Add OAuth login',
  body: 'Implement OAuth 2.0 login flow',
  labels: ['ready'],
  specRefs: ['AUTH-001'],
};

const validUnits = [
  {
    id: 'unit-auth-backend',
    title: 'Backend OAuth',
    specIds: ['AUTH-001'],
    specContent: 'backend spec',
    expectedArtifacts: ['src/auth.ts'],
    dependencies: [],
    batchNumber: 0,
    verificationCommand: 'pnpm test',
    context: 'implement oauth backend',
    estimatedChangeSize: 50,
  },
  {
    id: 'unit-auth-frontend',
    title: 'Frontend OAuth',
    specIds: ['AUTH-001'],
    specContent: 'frontend spec',
    expectedArtifacts: ['src/login.tsx'],
    dependencies: ['unit-auth-backend'],
    batchNumber: 1,
    verificationCommand: 'pnpm test',
    context: 'implement oauth frontend',
  },
];

function makeSessionResult(structuredData: unknown, exitStatus: SessionResult['exitStatus'] = 'completed'): SessionResult {
  return {
    output: 'done',
    structuredData,
    cost: 0.4,
    pitfallMarkers: [],
    exitStatus,
  };
}

function createMockRuntime(...results: Array<SessionResult | { ok: false; error: Error }>) {
  const calls = results.map((r) => {
    if ('ok' in r && r.ok === false) return Promise.resolve(r);
    return Promise.resolve(ok(r as SessionResult));
  });
  return {
    spawnSession: vi.fn().mockImplementation(() => calls.shift() ?? Promise.resolve(ok(makeSessionResult({ units: [] })))),
    getCostTracker: vi.fn(),
  } as any;
}

describe('decompose', () => {
  it('parses valid structured output into a TaskGraph', async () => {
    const runtime = createMockRuntime(makeSessionResult({ units: validUnits }));
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, 'spec content');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issueNumber).toBe(7);
      expect(result.value.featureBranch).toBe('feature/7');
      expect(result.value.units).toHaveLength(2);
      expect(result.value.units[0]?.id).toBe('unit-auth-backend');
      expect(result.value.units[1]?.id).toBe('unit-auth-frontend');
    }
  });

  it('rejects structured output missing units array', async () => {
    const runtime = createMockRuntime(
      makeSessionResult({ tasks: [] }), // wrong key
      makeSessionResult({ tasks: [] }), // retry also fails
    );
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('missing units array');
    }
  });

  it('rejects null structured output', async () => {
    const runtime = createMockRuntime(
      makeSessionResult(null),
      makeSessionResult(null),
    );
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('not an object');
    }
  });

  it('retries once on first parse failure and succeeds', async () => {
    // First call: invalid data; retry call: valid data
    const runtime = createMockRuntime(
      makeSessionResult({ wrong: 'data' }),
      makeSessionResult({ units: validUnits }),
    );
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, 'spec');

    expect(result.ok).toBe(true);
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.value.units).toHaveLength(2);
    }
  });

  it('returns error when runtime fails on first call', async () => {
    const runtime = {
      spawnSession: vi.fn().mockResolvedValue({ ok: false, error: new Error('API error') }),
      getCostTracker: vi.fn(),
    } as any;
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('API error');
    }
    expect(runtime.spawnSession).toHaveBeenCalledTimes(1);
  });

  it('returns error when retry runtime call also fails', async () => {
    const runtime = {
      spawnSession: vi.fn()
        .mockResolvedValueOnce(ok(makeSessionResult({ wrong: 'data' }))) // first fails to parse
        .mockResolvedValueOnce({ ok: false, error: new Error('retry API error') }), // retry fails
      getCostTracker: vi.fn(),
    } as any;
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('retry API error');
    }
    expect(runtime.spawnSession).toHaveBeenCalledTimes(2);
  });

  it('passes workRequest title and body in variables', async () => {
    const runtime = createMockRuntime(makeSessionResult({ units: validUnits }));
    await decompose(mockWorkRequest, 'feature/7', runtime, 'my-spec');

    expect(runtime.spawnSession).toHaveBeenCalledWith(
      'coordinator',
      expect.objectContaining({
        variables: expect.objectContaining({
          workRequest: expect.stringContaining('Add OAuth login'),
          specs: 'my-spec',
          specRefs: 'AUTH-001',
        }),
      }),
      7,
    );
  });

  it('rejects a graph with duplicate unit IDs (validation failure)', async () => {
    const duplicateUnits = [
      { ...validUnits[0] },
      { ...validUnits[0] }, // duplicate id
    ];
    // Both calls return duplicate units — retry also fails validation
    const runtime = createMockRuntime(
      makeSessionResult({ units: duplicateUnits }),
      makeSessionResult({ units: duplicateUnits }),
    );
    const result = await decompose(mockWorkRequest, 'feature/7', runtime, '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('validation failed');
    }
  });
});
