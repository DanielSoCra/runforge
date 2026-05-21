import { describe, expect, it } from 'vitest';

import { SupabaseConfigReader } from './config-reader.js';

describe('SupabaseConfigReader retired shim', () => {
  it('fails closed on start', async () => {
    const reader = new SupabaseConfigReader();

    await expect(reader.start()).rejects.toThrow(
      /SupabaseConfigReader has been retired/,
    );
  });

  it('keeps read methods as inert compatibility exports', () => {
    const reader = new SupabaseConfigReader();

    expect(reader.getGlobalConfig()).toEqual({
      concurrencyLimit: 1,
      dailyBudgetLimit: null,
      defaultModel: 'claude-sonnet-4-6',
    });
    expect(reader.getRepoConfig('org', 'repo')).toBeUndefined();
    expect(() => reader.stop()).not.toThrow();
  });
});
