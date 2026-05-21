import { describe, expect, it } from 'vitest';

import { getSupabaseEnv } from './env';

describe('getSupabaseEnv', () => {
  it('fails closed because dashboard Supabase env is retired', () => {
    expect(() => getSupabaseEnv()).toThrow(
      'Dashboard Supabase environment variables are no longer used',
    );
  });
});
