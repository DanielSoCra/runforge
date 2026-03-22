import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @supabase/supabase-js before importing the module under test
const mockCreateClient = vi.fn().mockReturnValue({ fake: 'client' });
vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));

describe('getSupabaseClient', () => {
  let getSupabaseClient: typeof import('./client.js').getSupabaseClient;
  let resetSupabaseClient: typeof import('./client.js').resetSupabaseClient;

  beforeEach(async () => {
    // Reset module between tests so the singleton resets
    vi.resetModules();
    vi.mock('@supabase/supabase-js', () => ({
      createClient: mockCreateClient,
    }));
    mockCreateClient.mockClear();
    const mod = await import('./client.js');
    getSupabaseClient = mod.getSupabaseClient;
    resetSupabaseClient = mod.resetSupabaseClient;
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('returns null when SUPABASE_URL is missing', () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'key';
    expect(getSupabaseClient()).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns null when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(getSupabaseClient()).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns null when both env vars are missing', () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(getSupabaseClient()).toBeNull();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns a client when both env vars are set', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    const client = getSupabaseClient();
    expect(client).toEqual({ fake: 'client' });
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'test-key',
      { auth: { persistSession: false } },
    );
  });

  it('returns the same singleton on repeated calls', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    const first = getSupabaseClient();
    const second = getSupabaseClient();
    expect(first).toBe(second);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it('resetSupabaseClient allows re-initialization with new env vars', () => {
    process.env.SUPABASE_URL = 'https://old.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'old-key';
    const first = getSupabaseClient();
    expect(first).toEqual({ fake: 'client' });

    resetSupabaseClient();

    // After reset, missing env vars should return null
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(getSupabaseClient()).toBeNull();
  });

  it('resetSupabaseClient allows creating a new client with different config', () => {
    process.env.SUPABASE_URL = 'https://old.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'old-key';
    getSupabaseClient();
    expect(mockCreateClient).toHaveBeenCalledTimes(1);

    resetSupabaseClient();

    process.env.SUPABASE_URL = 'https://new.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'new-key';
    getSupabaseClient();
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenLastCalledWith(
      'https://new.supabase.co',
      'new-key',
      { auth: { persistSession: false } },
    );
  });
});
