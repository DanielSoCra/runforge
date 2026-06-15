import { describe, expect, it } from 'vitest';
import { SessionError } from '../session-error.js';
import {
  ProviderRegistry,
  classifyProviderFailure,
} from './registry.js';
import type { ProviderDefinition } from '../../types.js';
import { ConfigSchema } from '../../config.js';

const baseConfig = {
  repo: { owner: 'test-owner', name: 'test-repo' },
  controlPort: 3847,
  pollIntervalMs: 30000,
  maxConcurrentRuns: 1,
  dailyBudget: 50,
  perRunBudget: 10,
  adapter: 'cli' as const,
  branches: { staging: 'staging', production: 'main' },
  webhooks: [],
  validation: {
    gate1Commands: ['vitest run', 'tsc --noEmit'],
    maxFixCycles: 3,
  },
};

const providers: ProviderDefinition[] = [
  {
    name: 'codex-planner',
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

describe('ProviderRegistry (#480)', () => {
  it('resolves preferred provider by model tier', () => {
    const registry = new ProviderRegistry({
      providers,
      defaultProvider: 'claude-default',
      fallbackChain: ['codex-planner'],
    });

    const resolved = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('codex-planner');
  });

  it('falls back when the preferred provider is cooling down', () => {
    const registry = new ProviderRegistry({
      providers,
      defaultProvider: 'codex-planner',
      fallbackChain: ['claude-default'],
    });
    registry.reportFailure('codex-planner', 'transient', {
      rateLimited: true,
      retryAfterMs: 60_000,
      now: 10,
    });

    const resolved = registry.resolve(undefined, 'higher-capability', {
      now: 20,
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('claude-default');
    expect(registry.getHealth('codex-planner')?.cooldownUntil).toBe(60_010);
    expect(registry.getHealth('claude-default')?.cooldownUntil).toBe(0);
  });

  it('returns configuration-error for unknown binding providers', () => {
    const registry = new ProviderRegistry({
      providers,
      defaultProvider: 'claude-default',
      fallbackChain: [],
    });

    const resolved = registry.resolve(
      { preferred: 'missing-provider' },
      'standard-capability',
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.kind).toBe('configuration-error');
  });

  it('classifies missing binaries as terminal and rate limits as transient', () => {
    expect(classifyProviderFailure(new Error('spawn codex ENOENT'))).toBe(
      'terminal',
    );
    expect(
      classifyProviderFailure(
        new SessionError('Rate limited by upstream provider', 0.12, true),
      ),
    ).toBe('transient');
  });
});

describe('ProviderRegistry.fromConfig — production smoke-proof gate', () => {
  it('excludes unproven providers from resolve until they have a passing SmokeProof', () => {
    const parsed = ConfigSchema.safeParse({
      ...baseConfig,
      providers: {
        defaultProvider: 'codex-planner',
        fallbackChain: ['claude-default'],
        definitions: {
          'claude-default': {
            name: 'claude-default',
            adapterClass: 'process-based',
            providerKind: 'claude-cli',
            supportedModelTiers: [
              'standard-capability',
              'higher-capability',
            ],
            cliTool: 'claude',
          },
          'codex-planner': {
            name: 'codex-planner',
            adapterClass: 'process-based',
            providerKind: 'codex-cli',
            supportedModelTiers: ['higher-capability'],
            cliTool: 'codex',
            model: 'gpt-5.5',
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const registry = ProviderRegistry.fromConfig(parsed.data);
    // Seed the fallback with a passing smoke proof so the gate can demonstrate
    // that an unproven preferred provider is skipped.
    registry.markSmokeProof('claude-default', 'higher-capability');
    // Without a passing SmokeProof, the preferred provider is skipped and the
    // fallback is chosen.
    const unproven = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(unproven.ok).toBe(true);
    if (unproven.ok) expect(unproven.provider.name).toBe('claude-default');

    // After a passing smoke proof, the preferred provider resolves normally.
    registry.markSmokeProof('codex-planner', 'higher-capability');
    const proven = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(proven.ok).toBe(true);
    if (proven.ok) expect(proven.provider.name).toBe('codex-planner');
  });
});
