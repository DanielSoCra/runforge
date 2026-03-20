import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const URL = process.env['SUPABASE_URL']!;
const SERVICE = process.env['SUPABASE_SERVICE_KEY']!;
const ANON = process.env['SUPABASE_ANON_KEY']!;
const ADMIN_JWT = process.env['SUPABASE_TEST_ADMIN_JWT'];
const VIEWER_JWT = process.env['SUPABASE_TEST_VIEWER_JWT'];

const svc = createClient(URL, SERVICE);

describe('repo_plugins RLS', () => {
  let repoId: string;

  beforeAll(async () => {
    const { data } = await svc.from('repos')
      .insert({ owner: 'rls-test', name: 'plugin-test', enabled: false,
        staging_branch: 'staging', production_branch: 'main', concurrency_limit: 1 })
      .select('id').single();
    repoId = data!.id;
    await svc.from('repo_plugins').insert({ repo_id: repoId, plugin_id: 'test-plugin' });
  });

  afterAll(async () => {
    await svc.from('repos').delete().eq('id', repoId);
  });

  it('unauthenticated cannot read repo_plugins', async () => {
    const { data } = await createClient(URL, ANON).from('repo_plugins').select('*');
    expect(data).toEqual([]);
  });

  it.skipIf(!ADMIN_JWT)('admin can read repo_plugins', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { data } = await client.from('repo_plugins').select('*').eq('repo_id', repoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!VIEWER_JWT)('viewer can read repo_plugins', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { data } = await client.from('repo_plugins').select('*').eq('repo_id', repoId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!VIEWER_JWT)('viewer cannot insert into repo_plugins', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { error } = await client.from('repo_plugins').insert({ repo_id: repoId, plugin_id: 'viewer-attempt' });
    expect(error).not.toBeNull();
  });

  it.skipIf(!ADMIN_JWT)('admin can update repo_plugins', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { error } = await client.from('repo_plugins')
      .update({ active: true })
      .eq('repo_id', repoId)
      .eq('plugin_id', 'test-plugin');
    expect(error).toBeNull();
  });

  it.skipIf(!VIEWER_JWT)('viewer cannot update repo_plugins', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { error } = await client.from('repo_plugins')
      .update({ active: false })
      .eq('repo_id', repoId)
      .eq('plugin_id', 'test-plugin');
    expect(error).not.toBeNull();
  });
});
