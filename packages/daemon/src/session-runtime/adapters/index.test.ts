// src/session-runtime/adapters/index.test.ts
import { describe, it, expect } from 'vitest';
import {
  createAdapter,
  createProviderAdapter,
  CliAdapter,
  CodexCliAdapter,
  PiCliAdapter,
} from './index.js';
import type { ProviderDefinition } from '../../types.js';

describe('createAdapter', () => {
  it('returns a CliAdapter for "cli" type', () => {
    const adapter = createAdapter('cli');
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('throws for "sdk" type (not yet implemented)', () => {
    expect(() => createAdapter('sdk')).toThrow('SDK adapter not yet implemented');
  });

  it('returned CliAdapter satisfies ProviderAdapter interface (has spawn method)', () => {
    const adapter = createAdapter('cli');
    expect(typeof adapter.spawn).toBe('function');
  });
});

describe('createProviderAdapter (#480)', () => {
  const baseProvider: ProviderDefinition = {
    name: 'provider',
    adapterClass: 'process-based',
    providerKind: 'claude-cli',
    supportedModelTiers: ['standard-capability'],
  };

  it('returns Claude CLI adapter for claude-cli providers', () => {
    expect(createProviderAdapter(baseProvider)).toBeInstanceOf(CliAdapter);
  });

  it('returns Codex CLI adapter for codex-cli providers', () => {
    expect(
      createProviderAdapter({
        ...baseProvider,
        providerKind: 'codex-cli',
      }),
    ).toBeInstanceOf(CodexCliAdapter);
  });

  it('returns Pi CLI adapter for pi-cli providers', () => {
    expect(
      createProviderAdapter({
        ...baseProvider,
        providerKind: 'pi-cli',
      }),
    ).toBeInstanceOf(PiCliAdapter);
  });
});
