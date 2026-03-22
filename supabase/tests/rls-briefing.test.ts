import { createClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const URL = process.env['SUPABASE_URL']!;
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!;
const ANON = process.env['SUPABASE_ANON_KEY']!;
const ADMIN_JWT = process.env['SUPABASE_TEST_ADMIN_JWT'];
const VIEWER_JWT = process.env['SUPABASE_TEST_VIEWER_JWT'];

const svc = createClient(URL, SERVICE);
const isCI = !!process.env.CI;

describe('briefings RLS', () => {
  let briefingId: string;

  beforeAll(async () => {
    const { data } = await svc.from('briefings')
      .insert({
        status_line: 'RLS test briefing',
        changes: [],
        attention: [],
        forecast: 'Test forecast',
        signal_snapshot: {},
      })
      .select('id').single();
    briefingId = data!.id;
  });

  afterAll(async () => {
    await svc.from('briefings').delete().eq('id', briefingId);
  });

  it('authenticated RLS tests must not be silently skipped in CI', () => {
    if (isCI) {
      expect(ADMIN_JWT, 'SUPABASE_TEST_ADMIN_JWT must be set in CI').toBeTruthy();
      expect(VIEWER_JWT, 'SUPABASE_TEST_VIEWER_JWT must be set in CI').toBeTruthy();
    } else if (!ADMIN_JWT || !VIEWER_JWT) {
      console.warn(
        '\n⚠ SUPABASE_TEST_ADMIN_JWT and/or SUPABASE_TEST_VIEWER_JWT not set.\n' +
        '  Authenticated RLS tests will be SKIPPED.\n'
      );
    }
  });

  it('unauthenticated cannot read briefings', async () => {
    const { data } = await createClient(URL, ANON).from('briefings').select('*');
    expect(data).toEqual([]);
  });

  it.skipIf(!ADMIN_JWT)('admin can read briefings', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { data } = await client.from('briefings').select('*').eq('id', briefingId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!VIEWER_JWT)('viewer can read briefings', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { data } = await client.from('briefings').select('*').eq('id', briefingId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!ADMIN_JWT)('admin cannot insert into briefings', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { error } = await client.from('briefings').insert({
      status_line: 'admin attempt',
      forecast: 'test',
    });
    expect(error).not.toBeNull();
  });
});

describe('activity_events RLS', () => {
  let eventId: string;

  beforeAll(async () => {
    const { data } = await svc.from('activity_events')
      .insert({
        event_type: 'heartbeat',
        severity: 'info',
        summary: 'RLS test event',
        links: [],
      })
      .select('id').single();
    eventId = data!.id;
  });

  afterAll(async () => {
    await svc.from('activity_events').delete().eq('id', eventId);
  });

  it('unauthenticated cannot read activity_events', async () => {
    const { data } = await createClient(URL, ANON).from('activity_events').select('*');
    expect(data).toEqual([]);
  });

  it.skipIf(!ADMIN_JWT)('admin can read activity_events', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { data } = await client.from('activity_events').select('*').eq('id', eventId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!VIEWER_JWT)('viewer can read activity_events', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${VIEWER_JWT}` } } });
    const { data } = await client.from('activity_events').select('*').eq('id', eventId);
    expect(data?.length).toBeGreaterThan(0);
  });

  it.skipIf(!ADMIN_JWT)('admin cannot insert into activity_events', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { error } = await client.from('activity_events').insert({
      event_type: 'heartbeat',
      severity: 'info',
      summary: 'admin attempt',
    });
    expect(error).not.toBeNull();
  });
});

describe('notification_channel_configs RLS', () => {
  it('unauthenticated cannot read notification_channel_configs', async () => {
    const { data } = await createClient(URL, ANON).from('notification_channel_configs').select('*');
    expect(data).toEqual([]);
  });

  it.skipIf(!ADMIN_JWT)('admin cannot read notification_channel_configs (no policies)', async () => {
    const client = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } } });
    const { data } = await client.from('notification_channel_configs').select('*');
    expect(data).toEqual([]);
  });
});
