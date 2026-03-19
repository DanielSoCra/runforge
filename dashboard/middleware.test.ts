import { describe, it, expect } from 'vitest';

// Minimal smoke test: middleware module exports the right shape
describe('middleware', () => {
  it('exports a middleware function', async () => {
    const mod = await import('./middleware');
    expect(typeof mod.middleware).toBe('function');
  });

  it('defines a matcher config', async () => {
    const mod = await import('./middleware');
    expect(mod.config).toBeDefined();
    expect(mod.config.matcher).toBeDefined();
  });
});
