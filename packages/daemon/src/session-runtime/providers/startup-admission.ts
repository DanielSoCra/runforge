// src/session-runtime/providers/startup-admission.ts
//
// Startup smoke-proof admission orchestrator (follow-up #10).
//
// Wires the EXISTING proving-run machinery (smoke-test.ts) into daemon startup
// per ARCH-AC-SESSION-PROVIDERS "Provider proving (smoke test)" (lines ~115-119)
// and "Daemon startup" (lines ~128-135), and FUNC-AC-RUNTIME-ADAPTERS "Proving a
// runtime before trusting it" (lines ~74-84).
//
// DESIGN: this module is pure-ish — all I/O (real adapter spawn, disposable
// workspace, observed-change probe) is INJECTED via `runSmoke`. The orchestrator
// itself never does I/O and never throws on a policy outcome: a required provider
// failing its proving run is signalled via `result.aborted === true`, and the
// DAEMON decides to abort startup (fail fast). Optional providers that fail are
// recorded as degraded (not fatal). This keeps the orchestration unit-testable
// without live model calls (see startup-admission.test.ts).
//
// The flag-OFF path (`requireSmokeProof !== true`) is a byte-identical NO-OP:
// `runSmoke` is called ZERO times and the result is `{ skipped: true }`.

import type { ModelTier, ProviderDefinition } from '../../types.js';
import type { SmokeProof } from './smoke-test.js';

/**
 * One provider/model binding to be proven at startup. The daemon expands its
 * configured provider definitions (and their supported model tiers / declared
 * model bindings) into this flat list before handing them to `admitProviders`.
 */
export interface ProviderAdmissionBinding {
  provider: ProviderDefinition;
  /** The model binding string proven for this provider (mirrors smokeTest's 2nd arg). */
  modelBinding: string;
  /** The model tier the proof is recorded against (registry.markSmokeProof key). */
  tier: ModelTier;
  /** Required providers that fail their proving run abort daemon startup. */
  required: boolean;
}

/** Minimal logger surface — the daemon passes a console-like sink. */
export interface AdmissionLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * The slice of ProviderRegistry the orchestrator mutates. Typed structurally so
 * tests can inject a fake without constructing a full registry.
 */
export interface AdmissionRegistry {
  markSmokeProof(providerName: string, tier: string): void;
  markSmokeFailed(providerName: string, tier: string): void;
}

export interface AdmitProvidersOptions {
  registry: AdmissionRegistry;
  providers: Iterable<ProviderAdmissionBinding>;
  /**
   * Gate. When NOT exactly `true`, admission is a byte-identical NO-OP:
   * `runSmoke` is never called and the result is `{ skipped: true }`.
   */
  requireSmokeProof: boolean;
  /**
   * Injected I/O boundary that wraps the real `smokeTest` (adapter + disposable
   * workspace + observed-change probe) at the daemon edge. The orchestrator
   * itself never does I/O — tests inject a fake.
   */
  runSmoke: (
    provider: ProviderDefinition,
    modelBinding: string,
  ) => Promise<SmokeProof>;
  /**
   * The default resolution path UNBOUND work travels, keyed BY TIER: each tier the
   * path must serve → the ordered chain provider names that support that tier
   * (registry `defaultProvider` + `fallbackChain`, filtered to providers declaring
   * the tier). Admission aborts unless, FOR EVERY tier in the map, at least one of
   * its chain providers was admitted FOR THAT TIER — the registry gates resolve()
   * on a per-(provider,tier) proof, so a default standard-tier failure is not
   * absorbed by a higher-only fallback passing. When omitted, the weaker
   * zero-admitted rule applies instead.
   */
  criticalChainByTier?: ReadonlyMap<string, readonly string[]>;
  logger?: AdmissionLogger;
}

/** A provider/binding that passed its proving run and was admitted. */
export interface AdmittedProvider {
  providerName: string;
  modelBinding: string;
  tier: ModelTier;
}

/** A provider/binding that failed its proving run (required or optional). */
export interface FailedProvider {
  providerName: string;
  modelBinding: string;
  tier: ModelTier;
  required: boolean;
  cause: SmokeProof['cause'];
}

/**
 * Outcome of a startup admission pass.
 *
 * - `skipped` is `true` ONLY on the gate-OFF no-op path.
 * - `aborted` is `true` when at least one REQUIRED provider failed its proving
 *   run, OR when ZERO providers were admitted (no usable provider — e.g. only
 *   optional providers configured and all failed); `abortReasons` names the
 *   offending required providers and/or the no-provider-admitted reason. The
 *   orchestrator does NOT throw — the daemon reads `aborted` and aborts startup.
 * - Optional providers that fail land in `failed`; they set `aborted` only via the
 *   zero-admitted rule, never individually.
 */
export interface AdmissionResult {
  admitted: AdmittedProvider[];
  failed: FailedProvider[];
  aborted: boolean;
  abortReasons: string[];
  skipped: boolean;
}

/**
 * Build the tier-keyed critical resolution path for {@link admitProviders} from a
 * provider-definition map and the ordered default-resolution chain (the registry's
 * `defaultProvider` followed by its `fallbackChain`).
 *
 * The chain must serve EVERY tier ANY chain provider declares — an unbound request
 * for a fallback-only tier still resolves through this chain, so that tier needs a
 * proven provider too (not just the tiers the default provider supports). Each tier
 * maps to the chain providers (in chain order) that declare it.
 */
export function buildCriticalChainByTier(
  definitions: Record<string, ProviderDefinition>,
  chainNames: readonly string[],
): Map<string, string[]> {
  const tiers = new Set<ModelTier>();
  for (const name of chainNames) {
    for (const tier of definitions[name]?.supportedModelTiers ?? []) {
      tiers.add(tier);
    }
  }
  const byTier = new Map<string, string[]>();
  for (const tier of tiers) {
    byTier.set(
      tier,
      chainNames.filter(
        (n) => definitions[n]?.supportedModelTiers.includes(tier) === true,
      ),
    );
  }
  return byTier;
}

/**
 * Run the startup smoke-proof admission pass.
 *
 * @see AdmitProvidersOptions for the gate / no-op contract.
 * @see AdmissionResult for the abort signalling contract.
 */
export async function admitProviders(
  opts: AdmitProvidersOptions,
): Promise<AdmissionResult> {
  if (opts.requireSmokeProof !== true) {
    return {
      admitted: [],
      failed: [],
      aborted: false,
      abortReasons: [],
      skipped: true,
    };
  }

  const admitted: AdmittedProvider[] = [];
  const failed: FailedProvider[] = [];
  const abortReasons: string[] = [];

  for (const binding of opts.providers) {
    // A throwing runSmoke (e.g. the daemon's adapter construction rejects for a
    // provider kind) is a FAILED proof, not a startup crash: treat it like any
    // failed proving run so the required→abort / optional→degrade + cleanup path
    // still runs. Never let an injected I/O reject escape the orchestrator. (codex)
    let proof: SmokeProof;
    try {
      proof = await opts.runSmoke(binding.provider, binding.modelBinding);
    } catch (e) {
      opts.logger?.warn?.(
        `[admission] ${binding.provider.name} (${binding.modelBinding}) proving run threw: ${e instanceof Error ? e.message : String(e)} — treating as failed`,
      );
      proof = {
        providerName: binding.provider.name,
        modelBinding: binding.modelBinding,
        responded: false,
        observableChange: false,
        passed: false,
        cause: 'smoke-failed',
      };
    }
    if (proof.passed === true) {
      opts.registry.markSmokeProof(binding.provider.name, binding.tier);
      admitted.push({
        providerName: binding.provider.name,
        modelBinding: binding.modelBinding,
        tier: binding.tier,
      });
      opts.logger?.info?.(
        `[admission] ${binding.provider.name} (${binding.modelBinding}) admitted`,
      );
    } else {
      opts.registry.markSmokeFailed(binding.provider.name, binding.tier);
      failed.push({
        providerName: binding.provider.name,
        modelBinding: binding.modelBinding,
        tier: binding.tier,
        required: binding.required === true,
        cause: proof.cause,
      });
      if (binding.required === true) {
        abortReasons.push(binding.provider.name);
        opts.logger?.error?.(
          `[admission] REQUIRED provider ${binding.provider.name} (${binding.modelBinding}) smoke proof failed`,
        );
      } else {
        opts.logger?.warn?.(
          `[admission] OPTIONAL provider ${binding.provider.name} (${binding.modelBinding}) smoke proof failed`,
        );
      }
    }
  }

  // The default resolution path must remain usable. With smoke-proofing ON the
  // registry gates every resolve() on a proof, so the daemon would boot but
  // resolve `provider-unavailable` for unbound work if the path it resolves
  // through is unproven — even when some unrelated provider passed. Abort unless
  // at least one provider in the critical chain (defaultProvider + fallbackChain)
  // was admitted; when no chain is supplied, fall back to the weaker
  // zero-admitted rule (the common case: only optional providers, all failed).
  // (Only when no REQUIRED-failure reason already fired — those keep abortReasons
  // precise.) (codex)
  if (abortReasons.length === 0) {
    const byTier = opts.criticalChainByTier;
    if (byTier !== undefined && byTier.size > 0) {
      // admitted is keyed by (provider, tier) — match resolution exactly.
      const admittedSlots = new Set(
        admitted.map((a) => JSON.stringify([a.providerName, a.tier])),
      );
      const unservable: string[] = [];
      for (const [tier, names] of byTier) {
        if (!names.some((n) => admittedSlots.has(JSON.stringify([n, tier])))) {
          unservable.push(tier);
        }
      }
      if (unservable.length > 0) {
        abortReasons.push(
          `no admitted provider in the default resolution path for tier(s): ${unservable.join(', ')}`,
        );
        opts.logger?.error?.(
          `[admission] default resolution path unusable for tier(s) ${unservable.join(', ')} — startup cannot dispatch unbound work`,
        );
      }
    } else if (admitted.length === 0) {
      abortReasons.push('no provider passed smoke admission');
      opts.logger?.error?.(
        `[admission] no provider passed smoke admission — startup cannot dispatch work`,
      );
    }
  }

  const aborted = abortReasons.length > 0;
  if (!aborted) {
    opts.logger?.info?.(`[admission] ${admitted.length} provider(s) admitted`);
  }

  return {
    admitted,
    failed,
    aborted,
    abortReasons,
    skipped: false,
  };
}
