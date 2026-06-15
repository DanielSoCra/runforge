import type { Config } from '../../config.js';
import type {
  ModelTier,
  ProviderBinding,
  ProviderDefinition,
} from '../../types.js';
import { SessionError } from '../session-error.js';

export type ProviderFailureClass = 'transient' | 'terminal';

export type ResolveProviderResult =
  | { ok: true; provider: ProviderDefinition }
  | {
      ok: false;
      kind: 'configuration-error' | 'provider-unavailable';
      message: string;
    };

export interface ProviderHealthState {
  status: 'available' | 'degraded' | 'unavailable';
  consecutiveTerminalFailures: number;
  consecutiveTransientFailures: number;
  cooldownUntil: number;
  lastChecked: number;
}

export interface ProviderRegistryConfig {
  providers: ProviderDefinition[];
  defaultProvider: string;
  fallbackChain: string[];
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  requireSmokeProof?: boolean;
}

export interface ProviderResolveOptions {
  exclude?: Iterable<string>;
  now?: number;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();
  private readonly health = new Map<string, ProviderHealthState>();
  private readonly smokeProofs = new Map<string, boolean>();
  private readonly defaultProvider: string;
  private readonly fallbackChain: string[];
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly requireSmokeProof: boolean;

  constructor(config: ProviderRegistryConfig) {
    this.defaultProvider = config.defaultProvider;
    this.fallbackChain = config.fallbackChain;
    this.baseBackoffMs = config.baseBackoffMs ?? 5_000;
    this.maxBackoffMs = config.maxBackoffMs ?? 300_000;
    this.requireSmokeProof = config.requireSmokeProof ?? false;

    for (const provider of config.providers) {
      this.providers.set(provider.name, provider);
      this.health.set(provider.name, {
        status: 'available',
        consecutiveTerminalFailures: 0,
        consecutiveTransientFailures: 0,
        cooldownUntil: 0,
        lastChecked: 0,
      });
    }
  }

  static fromConfig(config: Config): ProviderRegistry {
    if (!config.providers) {
      return new ProviderRegistry({
        providers: [legacyProviderDefinition(config.adapter)],
        defaultProvider: 'default',
        fallbackChain: [],
        baseBackoffMs: config.retryBackoffBaseMs,
        maxBackoffMs: config.retryBackoffMaxMs,
      });
    }

    return new ProviderRegistry({
      providers: Object.values(config.providers.definitions),
      defaultProvider: config.providers.defaultProvider,
      fallbackChain: config.providers.fallbackChain,
      baseBackoffMs: config.retryBackoffBaseMs,
      maxBackoffMs: config.retryBackoffMaxMs,
    });
  }

  resolve(
    binding: ProviderBinding | undefined,
    tier: ModelTier,
    options?: ProviderResolveOptions,
  ): ResolveProviderResult {
    const now = options?.now ?? Date.now();
    const excluded = new Set(options?.exclude ?? []);
    const chain = this.buildResolutionChain(binding);

    const unknown = chain.find((name) => !this.providers.has(name));
    if (unknown) {
      return {
        ok: false,
        kind: 'configuration-error',
        message: `Unknown provider in binding or fallback chain: ${unknown}`,
      };
    }

    let sawTierCompatible = false;
    for (const name of chain) {
      if (excluded.has(name)) continue;
      const provider = this.providers.get(name);
      if (!provider) continue;
      if (!provider.supportedModelTiers.includes(tier)) continue;
      sawTierCompatible = true;
      if (!this.isEligible(name, now)) continue;
      if (!this.hasSmokeProof(name, tier)) continue;
      return { ok: true, provider };
    }

    return {
      ok: false,
      kind: sawTierCompatible ? 'provider-unavailable' : 'configuration-error',
      message: sawTierCompatible
        ? `No available provider for model tier ${tier}`
        : `No configured provider supports model tier ${tier}`,
    };
  }

  reportSuccess(providerName: string): void {
    const state = this.health.get(providerName);
    if (!state) return;
    state.status = 'available';
    state.consecutiveTransientFailures = 0;
    state.cooldownUntil = 0;
    state.lastChecked = Date.now();
  }

  markSmokeProof(providerName: string, tier: string): void {
    this.smokeProofs.set(this.smokeProofKey(providerName, tier), true);
  }

  markSmokeFailed(providerName: string, tier: string): void {
    this.smokeProofs.set(this.smokeProofKey(providerName, tier), false);
    const state = this.health.get(providerName);
    if (state) {
      state.status = 'degraded';
    }
  }

  private hasSmokeProof(providerName: string, tier: string): boolean {
    if (!this.requireSmokeProof) return true;
    return this.smokeProofs.get(this.smokeProofKey(providerName, tier)) === true;
  }

  private smokeProofKey(providerName: string, tier: string): string {
    return `${providerName}:${tier}`;
  }

  reportFailure(
    providerName: string,
    failureClass: ProviderFailureClass,
    options?: { rateLimited?: boolean; retryAfterMs?: number; now?: number },
  ): void {
    const state = this.health.get(providerName);
    if (!state) return;
    const now = options?.now ?? Date.now();
    state.lastChecked = now;

    if (failureClass === 'terminal') {
      state.status = 'degraded';
      state.consecutiveTerminalFailures += 1;
      state.consecutiveTransientFailures = 0;
      return;
    }

    state.consecutiveTransientFailures += 1;
    if (options?.rateLimited) {
      const backoff =
        options.retryAfterMs ??
        Math.min(
          this.baseBackoffMs * 2 ** (state.consecutiveTransientFailures - 1),
          this.maxBackoffMs,
        );
      state.cooldownUntil = now + backoff;
    }
  }

  getHealth(providerName: string): ProviderHealthState | undefined {
    const state = this.health.get(providerName);
    return state ? { ...state } : undefined;
  }

  private buildResolutionChain(binding: ProviderBinding | undefined): string[] {
    const chain: string[] = [];
    chain.push(binding?.preferred ?? this.defaultProvider);
    chain.push(...(binding?.fallback ?? []));
    chain.push(...this.fallbackChain);
    return [...new Set(chain)];
  }

  private isEligible(providerName: string, now: number): boolean {
    const state = this.health.get(providerName);
    if (!state) return false;
    return state.status === 'available' && state.cooldownUntil <= now;
  }
}

export function classifyProviderFailure(
  error: unknown,
): ProviderFailureClass {
  if (error instanceof SessionError && error.rateLimited) return 'transient';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    message.includes('enoent') ||
    message.includes('auth') ||
    message.includes('credential') ||
    message.includes('permission denied') ||
    message.includes('bad config') ||
    message.includes('invalid configuration')
  ) {
    return 'terminal';
  }
  return 'transient';
}

function legacyProviderDefinition(adapter: Config['adapter']): ProviderDefinition {
  return {
    name: 'default',
    adapterClass: adapter === 'cli' ? 'process-based' : 'programmatic-api',
    providerKind: 'claude-cli',
    supportedModelTiers: ['standard-capability', 'higher-capability'],
    required: true,
  };
}
