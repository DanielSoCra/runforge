// src/session-runtime/providers/startup-admission.test.ts
//
// ARCH-AC-SESSION-PROVIDERS v2 STARTUP-ADMISSION ACCEPTANCE GATE (IMMOVABLE).
//
// Pins startup smoke-proof admission (ARCH-AC-SESSION-PROVIDERS "Provider proving
// (smoke test)" lines ~115-119 + "Daemon startup" lines ~128-135;
// FUNC-AC-RUNTIME-ADAPTERS "Proving a runtime before trusting it" lines ~74-84):
//   - Gate OFF (requireSmokeProof !== true): byte-identical NO-OP — `runSmoke` is
//     called ZERO times and the result is { skipped: true }.
//   - Gate ON, all pass: each provider's proof is recorded via
//     registry.markSmokeProof(name, tier); result.admitted lists them; not aborted.
//   - Gate ON, a REQUIRED provider's proving run fails: markSmokeFailed(name, tier)
//     is called, result.aborted === true, and abortReasons names it (the daemon
//     fails fast — the orchestrator itself never throws).
//   - Gate ON, an OPTIONAL provider fails (others pass): markSmokeFailed is called,
//     aborted stays false (degraded, not fatal), result.failed lists the optional
//     one, result.admitted lists the passing ones.
//
// The smoke run is INJECTED (no live model call, no real adapter). Must FAIL until
// admitProviders is implemented (body is stubbed `throw`).
import { describe, expect, it, vi } from 'vitest';
import type { ModelTier, ProviderDefinition } from '../../types.js';
import type { SmokeProof } from './smoke-test.js';
import {
  admitProviders,
  buildCriticalChainByTier,
  type AdmissionRegistry,
  type ProviderAdmissionBinding,
} from './startup-admission.js';

const TIER: ModelTier = 'higher-capability';

function provider(name: string, required: boolean): ProviderDefinition {
  return {
    name,
    adapterClass: 'process-based',
    providerKind: 'codex-cli',
    supportedModelTiers: [TIER],
    cliTool: 'codex',
    model: 'gpt-5.5',
    required,
  };
}

function binding(name: string, required: boolean): ProviderAdmissionBinding {
  return {
    provider: provider(name, required),
    modelBinding: 'gpt-5.5',
    tier: TIER,
    required,
  };
}

function passProof(name: string): SmokeProof {
  return {
    providerName: name,
    modelBinding: 'gpt-5.5',
    responded: true,
    observableChange: true,
    passed: true,
  };
}

function failProof(name: string): SmokeProof {
  return {
    providerName: name,
    modelBinding: 'gpt-5.5',
    responded: false,
    observableChange: false,
    passed: false,
    cause: 'smoke-failed',
  };
}

// A fake registry recording the smoke-proof calls (mirrors the real
// markSmokeProof/markSmokeFailed signatures: (providerName, tier)).
function fakeRegistry(): AdmissionRegistry & {
  proofs: Array<{ name: string; tier: string }>;
  failures: Array<{ name: string; tier: string }>;
} {
  const proofs: Array<{ name: string; tier: string }> = [];
  const failures: Array<{ name: string; tier: string }> = [];
  return {
    proofs,
    failures,
    markSmokeProof(name: string, tier: string) {
      proofs.push({ name, tier });
    },
    markSmokeFailed(name: string, tier: string) {
      failures.push({ name, tier });
    },
  };
}

describe('buildCriticalChainByTier', () => {
  const defs: Record<string, ProviderDefinition> = {
    'codex-default': { ...provider('codex-default', false), supportedModelTiers: ['standard-capability'] },
    'claude-fallback': { ...provider('claude-fallback', false), supportedModelTiers: ['higher-capability'] },
  };

  it('includes FALLBACK-ONLY tiers, not just the default provider tiers (codex r5)', () => {
    // default serves standard-capability only; the fallback serves higher-capability.
    // An unbound higher-capability request resolves through this chain, so that
    // tier must be covered too — not only the default provider's tiers.
    const byTier = buildCriticalChainByTier(defs, ['codex-default', 'claude-fallback']);
    expect([...byTier.keys()].sort()).toEqual([
      'higher-capability',
      'standard-capability',
    ]);
    expect(byTier.get('standard-capability')).toEqual(['codex-default']);
    expect(byTier.get('higher-capability')).toEqual(['claude-fallback']);
  });

  it('maps each tier to the chain providers (in order) that declare it', () => {
    const both: Record<string, ProviderDefinition> = {
      a: { ...provider('a', false), supportedModelTiers: ['standard-capability', 'higher-capability'] },
      b: { ...provider('b', false), supportedModelTiers: ['higher-capability'] },
    };
    const byTier = buildCriticalChainByTier(both, ['a', 'b']);
    expect(byTier.get('standard-capability')).toEqual(['a']);
    expect(byTier.get('higher-capability')).toEqual(['a', 'b']);
  });
});

describe('admitProviders — startup smoke-proof admission gate', () => {
  it('GATE OFF (requireSmokeProof !== true): NO-OP — runSmoke called 0 times, result.skipped true', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) => passProof(p.name));

    const result = await admitProviders({
      registry,
      providers: [binding('codex-impl', true), binding('claude-opt', false)],
      requireSmokeProof: false,
      runSmoke,
    });

    expect(runSmoke).toHaveBeenCalledTimes(0);
    expect(result.skipped).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.admitted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(registry.proofs).toEqual([]);
    expect(registry.failures).toEqual([]);
  });

  it('GATE ON, all providers pass: each markSmokeProof called, admitted lists them, aborted=false', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) => passProof(p.name));

    const result = await admitProviders({
      registry,
      providers: [binding('codex-impl', true), binding('claude-impl', true)],
      requireSmokeProof: true,
      runSmoke,
    });

    expect(runSmoke).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.abortReasons).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(registry.proofs).toEqual([
      { name: 'codex-impl', tier: TIER },
      { name: 'claude-impl', tier: TIER },
    ]);
    expect(registry.failures).toEqual([]);
    expect(result.admitted.map((a) => a.providerName)).toEqual([
      'codex-impl',
      'claude-impl',
    ]);
  });

  it('GATE ON, a REQUIRED provider fails: markSmokeFailed called, aborted=true, abortReasons names it', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) =>
      p.name === 'codex-impl' ? failProof(p.name) : passProof(p.name),
    );

    const result = await admitProviders({
      registry,
      providers: [binding('codex-impl', true), binding('claude-impl', true)],
      requireSmokeProof: true,
      runSmoke,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReasons).toContain('codex-impl');
    // The orchestrator must NOT throw — the daemon decides to abort.
    expect(registry.failures).toContainEqual({ name: 'codex-impl', tier: TIER });
    expect(result.failed.map((f) => f.providerName)).toContain('codex-impl');
    // The passing required provider is still recorded as admitted.
    expect(registry.proofs).toContainEqual({ name: 'claude-impl', tier: TIER });
    expect(result.admitted.map((a) => a.providerName)).toContain('claude-impl');
  });

  it('GATE ON, an OPTIONAL provider fails (others pass): markSmokeFailed called, aborted=false, failed lists it, admitted lists the passing ones', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) =>
      p.name === 'claude-opt' ? failProof(p.name) : passProof(p.name),
    );

    const result = await admitProviders({
      registry,
      providers: [binding('codex-impl', true), binding('claude-opt', false)],
      requireSmokeProof: true,
      runSmoke,
    });

    expect(result.aborted).toBe(false);
    expect(result.abortReasons).toEqual([]);
    expect(registry.failures).toContainEqual({ name: 'claude-opt', tier: TIER });
    expect(result.failed.map((f) => f.providerName)).toEqual(['claude-opt']);
    expect(result.failed[0]?.required).toBe(false);
    expect(registry.proofs).toContainEqual({ name: 'codex-impl', tier: TIER });
    expect(result.admitted.map((a) => a.providerName)).toEqual(['codex-impl']);
  });

  it('GATE ON, ALL providers OPTIONAL and ALL fail: aborts (zero admitted → no usable provider, codex)', async () => {
    // With smoke-proofing ON the registry gates every resolve() on a proof; if
    // nothing is admitted the daemon would start but resolve provider-unavailable
    // for all work. Zero-admitted must abort even though no provider was required.
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) => failProof(p.name));

    const result = await admitProviders({
      registry,
      providers: [binding('claude-opt', false), binding('codex-opt', false)],
      requireSmokeProof: true,
      runSmoke,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReasons).toContain('no provider passed smoke admission');
    expect(result.admitted).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });

  it('GATE ON, the default-resolution-path provider fails while an UNRELATED provider passes: aborts (critical chain unusable, codex)', async () => {
    // defaultProvider fails; an unrelated optional provider passes. Zero-admitted
    // would NOT fire (one admitted), but unbound work resolves through the default
    // path which is now unproven for TIER → must abort.
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) =>
      p.name === 'codex-default' ? failProof(p.name) : passProof(p.name),
    );

    const result = await admitProviders({
      registry,
      providers: [binding('codex-default', false), binding('claude-side', false)],
      requireSmokeProof: true,
      criticalChainByTier: new Map([[TIER, ['codex-default']]]),
      runSmoke,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReasons.join(' ')).toContain('default resolution path');
    // The unrelated provider WAS admitted — abort is about the resolution path.
    expect(result.admitted.map((a) => a.providerName)).toEqual(['claude-side']);
  });

  it('GATE ON, default fails but a FALLBACK serving the same tier passes: does NOT abort (chain absorbs it)', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) =>
      p.name === 'codex-default' ? failProof(p.name) : passProof(p.name),
    );

    const result = await admitProviders({
      registry,
      providers: [binding('codex-default', false), binding('claude-fallback', false)],
      requireSmokeProof: true,
      criticalChainByTier: new Map([[TIER, ['codex-default', 'claude-fallback']]]),
      runSmoke,
    });

    expect(result.aborted).toBe(false);
    expect(result.admitted.map((a) => a.providerName)).toEqual(['claude-fallback']);
  });

  it('GATE ON, tier-aware: default(TIER) fails and the only passing fallback serves a DIFFERENT tier → aborts for the unserved tier (codex r3)', async () => {
    // The fallback passes but for OTHER_TIER only; the default TIER path has no
    // admitted provider, so a standard-tier unbound task would resolve
    // provider-unavailable. The per-tier critical check must catch this.
    const OTHER_TIER: ModelTier = 'standard-capability';
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) =>
      p.name === 'codex-default' ? failProof(p.name) : passProof(p.name),
    );

    const result = await admitProviders({
      registry,
      providers: [
        { ...binding('codex-default', false), tier: TIER },
        { ...binding('claude-fallback', false), tier: OTHER_TIER },
      ],
      requireSmokeProof: true,
      // The chain must serve TIER; only codex-default supports TIER and it failed.
      criticalChainByTier: new Map([[TIER, ['codex-default']]]),
      runSmoke,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReasons.join(' ')).toContain(TIER);
  });

  it('GATE ON, MULTIPLE required providers fail: abortReasons names every offender (ordering/parallelism unobservable)', async () => {
    const registry = fakeRegistry();
    const runSmoke = vi.fn(async (p: ProviderDefinition) => failProof(p.name));

    const result = await admitProviders({
      registry,
      providers: [binding('codex-impl', true), binding('claude-impl', true)],
      requireSmokeProof: true,
      runSmoke,
    });

    expect(result.aborted).toBe(true);
    // Assert on membership, not order — admission ordering/parallelism is
    // unobservable; only the registry calls + result content are contractual.
    expect(result.abortReasons).toEqual(
      expect.arrayContaining(['codex-impl', 'claude-impl']),
    );
    expect(result.abortReasons).toHaveLength(2);
    expect(registry.failures).toEqual(
      expect.arrayContaining([
        { name: 'codex-impl', tier: TIER },
        { name: 'claude-impl', tier: TIER },
      ]),
    );
    expect(result.admitted).toEqual([]);
  });
});
