import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn().mockResolvedValue({ content: [] }) },
  })),
}));

import { togglePlugin, enableAllSuggested, triggerRecommendation } from './plugins.js';
import { createClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';
import { requireAdmin } from '@/lib/auth';
import Anthropic from '@anthropic-ai/sdk';

const mockRegistry = { version: 1, plugins: [{ id: 'web-stack', name: 'Web Stack', description: '', tags: [] }] };

describe('togglePlugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated callers', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(result.error).toContain('Unauthorized');
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
  });

  it('rejects unknown plugin ids', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(createClient).mockResolvedValue({} as never);
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
  });

  it('upserts repo_plugins on valid plugin id', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createClient).mockResolvedValue({
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
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    const fromSpy = vi.fn();
    vi.mocked(createClient).mockResolvedValue({ from: fromSpy } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.failed.length).toBe(0);
    expect(result.succeeded.length).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('queries DB for recommended+inactive plugins instead of accepting caller IDs', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(eqRecommended).toHaveBeenCalledWith('recommended', true);
    expect(eqActive).toHaveBeenCalledWith('active', false);
    expect(result.succeeded).toContain('web-stack');
    expect(result.failed).toHaveLength(0);
  });

  it('tracks plugins whose toggle failed in failed array', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: { message: 'db error' } });
    const eqActive = vi.fn().mockResolvedValue({ data: [{ plugin_id: 'web-stack' }], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.failed).toContain('web-stack');
    expect(result.succeeded).toHaveLength(0);
  });

  it('succeeds for some plugins even when others fail (independent upserts)', async () => {
    const multiRegistry = {
      version: 1,
      plugins: [
        { id: 'web-stack', name: 'Web Stack', description: '', tags: [] },
        { id: 'api-tools', name: 'API Tools', description: '', tags: [] },
      ],
    };
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(loadDashboardRegistry).mockResolvedValue(multiRegistry);

    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: null })        // web-stack succeeds
      .mockResolvedValueOnce({ error: { message: 'db error' } }); // api-tools fails
    const eqActive = vi.fn().mockResolvedValue({
      data: [{ plugin_id: 'web-stack' }, { plugin_id: 'api-tools' }],
      error: null,
    });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: (table: string) => (table === 'repo_plugins' ? { select, upsert } : { upsert }),
    } as never);

    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toEqual(['web-stack']);
    expect(result.failed).toEqual(['api-tools']);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('returns empty arrays when the DB query errors', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    const eqActive = vi.fn().mockResolvedValue({ data: null, error: { message: 'rls violation' } });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('returns empty arrays when no recommended+inactive plugins exist', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'u1' } as never);
    const eqActive = vi.fn().mockResolvedValue({ data: [], error: null });
    const eqRecommended = vi.fn().mockReturnValue({ eq: eqActive });
    const eqRepoId = vi.fn().mockReturnValue({ eq: eqRecommended });
    const select = vi.fn().mockReturnValue({ eq: eqRepoId });
    vi.mocked(createClient).mockResolvedValue({
      from: () => ({ select }),
    } as never);
    const result = await enableAllSuggested('repo-id');
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

describe('triggerRecommendation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns early without calling Anthropic when unauthenticated', async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(createClient).mockResolvedValue({} as never);
    // Should return without throwing
    await expect(triggerRecommendation('repo-id', 'owner', 'repo')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoOwner fails SAFE_PATTERN', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    // repoOwner with spaces fails the pattern
    await expect(triggerRecommendation('repo-id', 'owner with spaces', 'repo')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });

  it('returns early when repoName fails SAFE_PATTERN', async () => {
    vi.mocked(requireAdmin).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(createClient).mockResolvedValue({} as never);
    // repoName with semicolon fails the pattern
    await expect(triggerRecommendation('repo-id', 'owner', 'repo;evil')).resolves.toBeUndefined();
    expect(vi.mocked(loadDashboardRegistry)).not.toHaveBeenCalled();
    expect(vi.mocked(Anthropic)).not.toHaveBeenCalled();
  });
});
