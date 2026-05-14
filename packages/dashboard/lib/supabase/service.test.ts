import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from './service';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ kind: 'supabase-service-client' })),
}));

describe('createServiceClient', () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (originalServiceRoleKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('names NEXT_PUBLIC_SUPABASE_URL when the dashboard URL is missing (#548)', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    expect(() => createServiceClient()).toThrow('Missing NEXT_PUBLIC_SUPABASE_URL');
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('names SUPABASE_SERVICE_ROLE_KEY when the service key is missing', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createServiceClient()).toThrow('Missing SUPABASE_SERVICE_ROLE_KEY');
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('creates a Supabase service client when both env vars are set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const client = createServiceClient();

    expect(createSupabaseClient).toHaveBeenCalledWith('https://test.supabase.co', 'service-role-key');
    expect(client).toEqual({ kind: 'supabase-service-client' });
  });
});
