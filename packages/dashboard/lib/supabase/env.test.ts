import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSupabaseEnv } from './env';

describe('getSupabaseEnv', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    // Restore original values
    if (originalUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (originalKey !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
    else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it('throws descriptive error when NEXT_PUBLIC_SUPABASE_URL is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-key';

    expect(() => getSupabaseEnv()).toThrow('Missing NEXT_PUBLIC_SUPABASE_URL');
  });

  it('throws descriptive error when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    expect(() => getSupabaseEnv()).toThrow('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('returns url and anonKey when both are set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

    const result = getSupabaseEnv();
    expect(result).toEqual({
      url: 'https://test.supabase.co',
      anonKey: 'test-anon-key',
    });
  });
});
