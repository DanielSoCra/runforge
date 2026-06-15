// src/session-runtime/providers/safety-baseline.test.ts
//
// FUNC-AC-RUNTIME-ADAPTERS v2 ACCEPTANCE GATE (IMMOVABLE).
//
// Two v2 guarantees, both pure/registry-level (no spawn, no model):
//
// 1. SAFETY BASELINE for non-native-guard runtimes
//    (ARCH-AC-SESSION-PROVIDERS v2 ContainmentCapabilityProfile composition):
//    a runtime declaring nativeGuardHooks: false gets the compensating baseline
//    in full — isolated workspace + deterministic gates + strongest-level
//    independent review — and is NEVER weaker than the native runtime. The
//    profile can only ADD compensating controls, never remove any. No runtime
//    buys its way past the gates.
//
// 2. SMOKE-PROOF GATE on resolution
//    (ARCH-AC-SESSION-PROVIDERS v2 "Execute smoke test"): a provider without a
//    current passing SmokeProof is excluded from resolution for real work; a
//    smoke failure degrades it with cause 'smoke-failed'.
//
// Must FAIL until composeContainmentBaseline + the registry smoke gate exist.
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition } from '../../types.js';
import { ProviderRegistry } from './registry.js';
import { composeContainmentBaseline } from './safety-baseline.js';
import type { ContainmentCapabilityProfile } from '../adapters/types.js';

const nativeProfile: ContainmentCapabilityProfile = {
  nativeGuardHooks: true,
  structuredOutput: true,
  exactCostReporting: true,
  sessionContinuation: true,
};

const nonNativeProfile: ContainmentCapabilityProfile = {
  nativeGuardHooks: false,
  structuredOutput: false,
  exactCostReporting: false,
  sessionContinuation: true,
};

describe('composeContainmentBaseline — non-native-guard runtimes get the floor', () => {
  it('a nativeGuardHooks:false profile gets isolation + deterministic gates + strongest review', () => {
    const controls = composeContainmentBaseline(nonNativeProfile);
    expect(controls.isolatedWorkspace).toBe(true);
    expect(controls.deterministicGates).toBe(true);
    expect(controls.requiredReviewLevel).toBe('strongest');
  });

  it('never weaker than native: the native runtime is also gated and reviewed', () => {
    const native = composeContainmentBaseline(nativeProfile);
    const nonNative = composeContainmentBaseline(nonNativeProfile);
    // Deterministic gates and independent review apply to ALL work — no runtime
    // buys its way past the gates.
    expect(native.deterministicGates).toBe(true);
    expect(nonNative.deterministicGates).toBe(true);
    // The non-native runtime must demand at least as strong a review level as
    // native, and isolation must not be relaxed below native's.
    expect(nonNative.requiredReviewLevel).toBe('strongest');
    expect(nonNative.isolatedWorkspace).toBe(true);
  });

  it('the profile can only ADD compensating controls, never remove isolation', () => {
    // Even a profile claiming every native integration cannot drop below the
    // isolated-workspace + gates floor.
    const controls = composeContainmentBaseline({
      ...nativeProfile,
      nativeGuardHooks: true,
    });
    expect(controls.isolatedWorkspace).toBe(true);
    expect(controls.deterministicGates).toBe(true);
  });
});

// --- Smoke-proof gate on resolution ---

const providers: ProviderDefinition[] = [
  {
    name: 'codex-impl',
    adapterClass: 'process-based',
    providerKind: 'codex-cli',
    supportedModelTiers: ['higher-capability'],
    cliTool: 'codex',
    model: 'gpt-5.5',
  },
  {
    name: 'claude-default',
    adapterClass: 'process-based',
    providerKind: 'claude-cli',
    supportedModelTiers: ['standard-capability', 'higher-capability'],
    cliTool: 'claude',
  },
];

function newRegistry(): ProviderRegistry {
  return new ProviderRegistry({
    providers,
    defaultProvider: 'codex-impl',
    fallbackChain: ['claude-default'],
    // Opt the gate in for this registry — real work requires a passing proof.
    requireSmokeProof: true,
  });
}

describe('Smoke-proof gate excludes unproven providers from real work', () => {
  it('an unproven provider is not resolved; resolution falls to a proven fallback', () => {
    const registry = newRegistry();
    // Only the fallback has a passing proof.
    registry.markSmokeProof('claude-default', 'higher-capability');

    const resolved = registry.resolve(
      { preferred: 'codex-impl' },
      'higher-capability',
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('claude-default');
  });

  it('a smoke-failed provider is degraded with cause smoke-failed and skipped', () => {
    const registry = newRegistry();
    registry.markSmokeProof('claude-default', 'higher-capability');
    registry.markSmokeFailed('codex-impl', 'higher-capability');

    const health = registry.getHealth('codex-impl');
    expect(health?.status).toBe('degraded');

    const resolved = registry.resolve(
      { preferred: 'codex-impl' },
      'higher-capability',
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('claude-default');
  });

  it('a proven provider resolves normally', () => {
    const registry = newRegistry();
    registry.markSmokeProof('codex-impl', 'higher-capability');

    const resolved = registry.resolve(
      { preferred: 'codex-impl' },
      'higher-capability',
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('codex-impl');
  });
});
