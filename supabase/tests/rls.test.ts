import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const ADMIN_JWT = process.env.SUPABASE_TEST_ADMIN_JWT!;
const VIEWER_JWT = process.env.SUPABASE_TEST_VIEWER_JWT!;

const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);

describe('RLS policies', () => {
  let testRepoId: string;

  beforeAll(async () => {
    const { data } = await serviceClient.from('repos').insert({
      owner: 'rls-test-org', name: 'rls-test-repo', enabled: false,
      staging_branch: 'staging', production_branch: 'main',
      budget_limit: 10.00, concurrency_limit: 1,
    }).select('id').single();
    testRepoId = data!.id;
  });

  afterAll(async () => {
    await serviceClient.from('repos').delete().eq('id', testRepoId);
  });

  // --- Unauthenticated ---
  it('unauthenticated client cannot read repos', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data } = await anonClient.from('repos').select('*');
    expect(data).toEqual([]);
  });

  it('unauthenticated client cannot read runs', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data } = await anonClient.from('runs').select('*');
    expect(data).toEqual([]);
  });

  // --- Service role ---
  it('service role can insert and read repos', async () => {
    const { data } = await serviceClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBe(1);
  });

  it('global_settings row exists after migration', async () => {
    const { data } = await serviceClient.from('global_settings').select('*');
    expect(data?.length).toBe(1);
  });

  // --- Admin user ---
  it('admin user can read repos', async () => {
    if (!ADMIN_JWT) return;
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { data } = await adminClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('admin user can update repos', async () => {
    if (!ADMIN_JWT) return;
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { error } = await adminClient.from('repos')
      .update({ concurrency_limit: 2 })
      .eq('id', testRepoId);
    expect(error).toBeNull();
  });

  // --- Viewer user ---
  it('viewer user can read repos', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { data } = await viewerClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('viewer user cannot update repos', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { error } = await viewerClient.from('repos')
      .update({ concurrency_limit: 99 })
      .eq('id', testRepoId);
    expect(error).not.toBeNull();
  });

  it('viewer user cannot insert api_keys', async () => {
    if (!VIEWER_JWT) return;
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { error } = await viewerClient.from('api_keys').insert({
      repo_id: testRepoId, key_type: 'source-control', encrypted_value: 'fake',
    });
    expect(error).not.toBeNull();
  });
});
