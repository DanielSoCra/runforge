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

describe('ProviderRegistry.fromConfig — smoke-proof gate (opt-in)', () => {
  function rawConfigWithSmokeProof(requireSmokeProof?: boolean) {
    const providers: Record<string, unknown> = {
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
    };
    if (requireSmokeProof !== undefined) {
      providers.requireSmokeProof = requireSmokeProof;
    }
    return {
      ...baseConfig,
      providers,
    };
  }

  it('default config resolves a configured provider WITHOUT a smoke proof', () => {
    const parsed = ConfigSchema.safeParse(rawConfigWithSmokeProof());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.providers?.requireSmokeProof).toBe(false);
    const registry = ProviderRegistry.fromConfig(parsed.data);

    const resolved = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('codex-planner');
  });

  it('with requireSmokeProof:true, an unproven provider is skipped until marked proven', () => {
    const parsed = ConfigSchema.safeParse(rawConfigWithSmokeProof(true));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const registry = ProviderRegistry.fromConfig(parsed.data);
    registry.markSmokeProof('claude-default', 'higher-capability');

    const unproven = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(unproven.ok).toBe(true);
    if (unproven.ok) expect(unproven.provider.name).toBe('claude-default');

    registry.markSmokeProof('codex-planner', 'higher-capability');
    const proven = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(proven.ok).toBe(true);
    if (proven.ok) expect(proven.provider.name).toBe('codex-planner');
  });

  it('markSmokeProof restores health after a smoke failure', () => {
    const registry = new ProviderRegistry({
      providers,
      defaultProvider: 'codex-planner',
      fallbackChain: ['claude-default'],
      requireSmokeProof: true,
    });

    registry.markSmokeFailed('codex-planner', 'higher-capability');
    expect(registry.getHealth('codex-planner')?.status).toBe('degraded');
    expect(
      registry.resolve({ preferred: 'codex-planner' }, 'higher-capability').ok,
    ).toBe(false);

    registry.markSmokeProof('codex-planner', 'higher-capability');
    expect(registry.getHealth('codex-planner')?.status).toBe('available');
    const resolved = registry.resolve(
      { preferred: 'codex-planner' },
      'higher-capability',
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.name).toBe('codex-planner');
  });
});
