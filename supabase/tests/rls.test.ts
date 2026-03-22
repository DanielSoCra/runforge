import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const ADMIN_JWT = process.env.SUPABASE_TEST_ADMIN_JWT!;
const VIEWER_JWT = process.env.SUPABASE_TEST_VIEWER_JWT!;

const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY);

// NOTE: Admin/viewer tests are skipped if JWT env vars are absent.
// To run the full suite, set:
//   SUPABASE_TEST_ADMIN_JWT  — JWT for a user with role=admin in team_members
//   SUPABASE_TEST_VIEWER_JWT — JWT for a user with role=viewer in team_members
// In CI, generate these via the Supabase admin API or signInWithPassword.

const isCI = !!process.env.CI;

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

  // --- Guard: fail in CI if JWT env vars are missing (#20) ---
  it('authenticated RLS tests must not be silently skipped in CI', () => {
    if (isCI) {
      expect(ADMIN_JWT, 'SUPABASE_TEST_ADMIN_JWT must be set in CI — otherwise admin RLS tests are silently skipped').toBeTruthy();
      expect(VIEWER_JWT, 'SUPABASE_TEST_VIEWER_JWT must be set in CI — otherwise viewer RLS tests are silently skipped').toBeTruthy();
    } else if (!ADMIN_JWT || !VIEWER_JWT) {
      console.warn(
        '\n⚠ SUPABASE_TEST_ADMIN_JWT and/or SUPABASE_TEST_VIEWER_JWT not set.\n' +
        '  Authenticated RLS tests will be SKIPPED. Set these env vars for full coverage.\n'
      );
    }
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

  it('unauthenticated client cannot insert repos', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { error } = await anonClient.from('repos').insert({
      owner: 'hacker', name: 'hacked', enabled: false,
      staging_branch: 'main', production_branch: 'main',
    });
    expect(error).not.toBeNull();
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
  it.skipIf(!ADMIN_JWT)('admin user can read repos', async () => {
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { data } = await adminClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!ADMIN_JWT)('admin user can update repos', async () => {
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    const { error } = await adminClient.from('repos')
      .update({ concurrency_limit: 2 })
      .eq('id', testRepoId);
    expect(error).toBeNull();
  });

  // --- Viewer user ---
  it.skipIf(!VIEWER_JWT)('viewer user can read repos', async () => {
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { data } = await viewerClient.from('repos').select('*').eq('id', testRepoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!VIEWER_JWT)('viewer user cannot update repos', async () => {
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    await viewerClient.from('repos')
      .update({ concurrency_limit: 99 })
      .eq('id', testRepoId);
    // Verify the write was blocked — service client reads the ground truth
    const { data } = await serviceClient.from('repos')
      .select('concurrency_limit')
      .eq('id', testRepoId)
      .single();
    expect(data?.concurrency_limit).not.toBe(99);
  });

  it.skipIf(!VIEWER_JWT)('viewer user cannot insert api_keys', async () => {
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    const { error } = await viewerClient.from('api_keys').insert({
      repo_id: testRepoId, key_type: 'source-control', encrypted_value: 'fake',
    });
    expect(error).not.toBeNull();
  });

  // --- SEC-14: RPC privilege escalation regression tests ---

  it.skipIf(!ADMIN_JWT)('admin can call change_member_role RPC', async () => {
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    // Call with a non-existent member ID — should return 'not_found' (not a permission error)
    const { data, error } = await adminClient.rpc('change_member_role', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
      p_new_role: 'viewer',
    });
    expect(error).toBeNull();
    expect(data).toBe('not_found');
  });

  it.skipIf(!ADMIN_JWT)('admin can call remove_team_member RPC', async () => {
    const adminClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } },
    });
    // Call with a non-existent member ID — should return 'not_found' (not a permission error)
    const { data, error } = await adminClient.rpc('remove_team_member', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).toBeNull();
    expect(data).toBe('not_found');
  });

  it.skipIf(!VIEWER_JWT)('viewer cannot call change_member_role RPC', async () => {
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    // Attempt to escalate own role to admin — should be denied
    const { error } = await viewerClient.rpc('change_member_role', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
      p_new_role: 'admin',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('permission denied');
  });

  it.skipIf(!VIEWER_JWT)('viewer cannot call remove_team_member RPC', async () => {
    const viewerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } },
    });
    // Attempt to remove another team member — should be denied
    const { error } = await viewerClient.rpc('remove_team_member', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('permission denied');
  });

  it('unauthenticated client cannot call change_member_role RPC', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { error } = await anonClient.rpc('change_member_role', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
      p_new_role: 'admin',
    });
    // Blocked by REVOKE at the Postgres level, not by is_admin() guard
    expect(error).not.toBeNull();
  });

  it('unauthenticated client cannot call remove_team_member RPC', async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { error } = await anonClient.rpc('remove_team_member', {
      p_member_id: '00000000-0000-0000-0000-000000000000',
    });
    // Blocked by REVOKE at the Postgres level, not by is_admin() guard
    expect(error).not.toBeNull();
  });
});
