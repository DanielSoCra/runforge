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
    const result = await enableAllSuggested('repo-id');
    expect(result.failed.length).toBe(0);
    expect(result.succeeded.length).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('queries DB for recommended+inactive plugins instead of accepting caller IDs', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    // Build the SELECT chain: .eq('repo_id').eq('recommended').eq('active') → resolves to data
    // Each .eq() must return the next builder. The last .eq() returns a Promise (mockResolvedValue).
    // Use explicit nesting so each step is unambiguous:
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(eqRecommended).toHaveBeenCalledWith('recommended', true);
    expect(eqActive).toHaveBeenCalledWith('active', false);
    expect(result.succeeded).toContain('web-stack');
    expect(result.failed).toHaveLength(0);
  });

  it('tracks plugins whose toggle failed in failed array', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    // First call to togglePlugin will fail (upsert returns error)
    const upsert = vi.fn().mockResolvedValue({ error: { message: 'db error' } });
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.failed).toContain('web-stack');
    expect(result.succeeded).toHaveLength(0);
  });

  it('returns empty arrays when the DB query errors', async () => {
    const eqActive = vi.fn().mockResolvedValue({ data: null, error: { message: 'rls violation' } });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('returns empty arrays when no recommended+inactive plugins exist', async () => {
    const eqActive = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
