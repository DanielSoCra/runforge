import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createServerClient: vi.fn() }));
vi.mock('@/lib/plugins/registry', () => ({ loadDashboardRegistry: vi.fn() }));

import { togglePlugin, enableAllSuggested } from './plugins.js';
import { createServerClient } from '@/lib/supabase/server';
import { loadDashboardRegistry } from '@/lib/plugins/registry';

const mockRegistry = { version: 1, plugins: [{ id: 'web-stack', name: 'Web Stack', description: '', tags: [] }] };

describe('togglePlugin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unknown plugin ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const result = await togglePlugin('repo-id', 'unknown-plugin', true);
    expect(result.error).toContain('Unknown plugin');
  });

  it('upserts repo_plugins on valid plugin id', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createServerClient).mockReturnValue({ from: () => ({ upsert }) } as never);
    const result = await togglePlugin('repo-id', 'web-stack', true);
    expect(upsert).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});

describe('enableAllSuggested', () => {
  it('enables each suggested plugin independently and returns failed ids', async () => {
    vi.mocked(loadDashboardRegistry).mockResolvedValue(mockRegistry);
    const upsert = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'db error' } });
    vi.mocked(createServerClient).mockReturnValue({ from: () => ({ upsert }) } as never);
    const result = await enableAllSuggested('repo-id', ['web-stack', 'unknown']);
    expect(result.failed).toContain('unknown');
  });
});
