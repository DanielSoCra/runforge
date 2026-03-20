import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));

import { togglePlugin, enableAllSuggested } from './plugins.js';
import { createClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';

const mockRegistry = { version: 1, plugins: [{ id: 'web-stack', name: 'Web Stack', description: '', tags: [] }] };

describe('togglePlugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated callers', async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(result.error).toContain('Unauthorized');
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
  });

  it('rejects unknown plugin ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    } as never);
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
  });

  it('upserts repo_plugins on valid plugin id', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: () => ({ upsert }),
    } as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(upsert).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});

describe('enableAllSuggested', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated callers without querying DB', async () => {
    const fromSpy = vi.fn();
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from: fromSpy,
    } as never);
    const result = await enableAllSuggested('repo-id', []);
    expect(result.failed.length).toBe(0);
    expect(result.succeeded.length).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('enables each suggested plugin independently and returns failed ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'db error' } });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: () => ({ upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id', ['web-stack', 'unknown']);
    expect(result.failed).toContain('unknown');
  });

  it('tracks failed ids when a valid plugin upsert returns a db error', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValueOnce({ error: { message: 'db error' } });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: () => ({ upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id', ['web-stack']);
    expect(result.failed).toContain('web-stack');
    expect(result.succeeded).toHaveLength(0);
  });
});
