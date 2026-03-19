// src/session-runtime/adapters/index.test.ts
import { describe, it, expect } from 'vitest';
import { createAdapter, CliAdapter } from './index.js';

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
