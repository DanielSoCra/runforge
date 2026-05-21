import { describe, expect, it } from 'vitest';

import { getSupabaseClient, resetSupabaseClient } from './client.js';

describe('getSupabaseClient retired shim', () => {
  it('always returns null', () => {
    expect(getSupabaseClient()).toBeNull();
  });

  it('keeps resetSupabaseClient as a no-op compatibility export', () => {
    expect(() => resetSupabaseClient()).not.toThrow();
  });
});
