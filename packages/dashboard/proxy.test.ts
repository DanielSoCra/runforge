import { describe, it, expect } from 'vitest';

describe('proxy', () => {
  it('exports a proxy function', async () => {
    const mod = await import('./proxy');
    expect(typeof mod.proxy).toBe('function');
  });

  it('defines a matcher config', async () => {
    const mod = await import('./proxy');
    expect(mod.config).toBeDefined();
    expect(mod.config.matcher).toBeDefined();
  });
});
