import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDashboardRegistry } from './registry.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'fs/promises';

describe('loadDashboardRegistry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns parsed registry with plugin entries', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      version: 1,
      plugins: [{ id: 'web-stack', name: 'Web Stack', description: 'Frontend', tags: ['astro'] }],
    }) as never);
    const registry = await loadDashboardRegistry();
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]!.id).toBe('web-stack');
  });

  it('throws if registry.json is missing', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT') as never);
    await expect(loadDashboardRegistry()).rejects.toThrow();
  });
});
