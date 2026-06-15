// src/session-runtime/providers/smoke-test.test.ts
//
// FUNC-AC-RUNTIME-ADAPTERS v2 ACCEPTANCE GATE (IMMOVABLE).
//
// Pins the mandatory proving run (ARCH-AC-SESSION-PROVIDERS v2 "Execute smoke
// test"; STACK v2 smokeTest(provider, binding)):
//   - Runs a one-shot trivial task through the REAL adapter path (not a separate
//     "test mode") in a disposable workspace.
//   - PASS requires BOTH (a) the routed capability responded (non-empty
//     model-attributed output) AND (b) an observable output change was produced.
//   - PASS records a SmokeProof and admits the provider; FAIL degrades with
//     cause 'smoke-failed' and keeps it out of rotation.
//   - Distinct from a mere reachability probe.
//
// The adapter spawn is injected (no live model call). Must FAIL until
// smoke-test.ts exists.
import { describe, expect, it } from 'vitest';
import { ok, err } from '../../lib/result.js';
import type { ProviderDefinition, SessionResult } from '../../types.js';
import { SessionError } from '../session-error.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { smokeTest, type SmokeProof } from './smoke-test.js';

const provider: ProviderDefinition = {
  name: 'codex-impl',
  adapterClass: 'process-based',
  providerKind: 'codex-cli',
  supportedModelTiers: ['higher-capability'],
  cliTool: 'codex',
  model: 'gpt-5.5',
};

function fakeResult(over: Partial<SessionResult> = {}): SessionResult {
  return {
    output: 'created file proof.txt',
    structuredData: null,
    cost: 0,
    costEstimated: true,
    pitfallMarkers: [],
    exitStatus: 'completed',
    ...over,
  };
}

// A stub adapter whose spawn we control + a flag recording whether the REAL
// adapter spawn path (not a side "test mode") was exercised.
function stubAdapter(spawnImpl: ProviderAdapter['spawn']): ProviderAdapter & {
  spawnCalls: number;
} {
  const adapter: ProviderAdapter & { spawnCalls: number } = {
    spawnCalls: 0,
    async spawn(...args: Parameters<ProviderAdapter['spawn']>) {
      adapter.spawnCalls += 1;
      return spawnImpl(...args);
    },
    async resume() {
      throw new Error('not used in smoke test');
    },
    async abort() {
      /* noop */
    },
    capabilities() {
      return {
        nativeGuardHooks: false,
        structuredOutput: false,
        exactCostReporting: false,
        sessionContinuation: true,
      };
    },
  } as unknown as ProviderAdapter & { spawnCalls: number };
  return adapter;
}

describe('smokeTest — proving run gate', () => {
  it('PASSES when the routed capability responded AND an observable change was produced', async () => {
    const adapter = stubAdapter(async () =>
      ok(
        fakeResult({
          output: 'model says: created proof artifact',
          exitStatus: 'completed',
        }),
      ),
    );

    const proof: SmokeProof = await smokeTest(provider, 'gpt-5.5', {
      adapter,
      observedChange: () => true, // disposable workspace produced an artifact
    });

    expect(proof.passed).toBe(true);
    expect(proof.responded).toBe(true);
    expect(proof.observableChange).toBe(true);
    expect(proof.providerName).toBe('codex-impl');
    expect(proof.modelBinding).toBe('gpt-5.5');
    // It must run through the real adapter spawn path.
    expect(adapter.spawnCalls).toBe(1);
  });

  it('FAILS (smoke-failed) when nothing responded — empty model-attributed output', async () => {
    const adapter = stubAdapter(async () => ok(fakeResult({ output: '   ' })));

    const proof = await smokeTest(provider, 'gpt-5.5', {
      adapter,
      observedChange: () => true,
    });

    expect(proof.passed).toBe(false);
    expect(proof.responded).toBe(false);
    expect(proof.cause).toBe('smoke-failed');
  });

  it('FAILS when the response came but no observable change was produced (reachability != proof)', async () => {
    const adapter = stubAdapter(async () =>
      ok(fakeResult({ output: 'model responded' })),
    );

    const proof = await smokeTest(provider, 'gpt-5.5', {
      adapter,
      observedChange: () => false, // nothing changed on disk / no marker
    });

    expect(proof.passed).toBe(false);
    expect(proof.observableChange).toBe(false);
    expect(proof.cause).toBe('smoke-failed');
  });

  it('FAILS when the adapter spawn errors (the routed capability did not run)', async () => {
    const adapter = stubAdapter(async () =>
      err(new SessionError('spawn codex ENOENT', 0)),
    );

    const proof = await smokeTest(provider, 'gpt-5.5', {
      adapter,
      observedChange: () => true,
    });

    expect(proof.passed).toBe(false);
    expect(proof.cause).toBe('smoke-failed');
  });
});
