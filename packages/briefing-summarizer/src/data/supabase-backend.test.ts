import { describe, expect, it, vi } from 'vitest';

import { createSupabaseBriefingBackend } from './supabase-backend.js';

describe('Supabase briefing backend', () => {
  it('queries runs by updated_at so changed in-progress runs are included (#398)', async () => {
    const gte = vi.fn(() => Promise.resolve({ data: [], error: null }));
    const select = vi.fn(() => ({ gte }));
    const from = vi.fn(() => ({ select }));
    const backend = createSupabaseBriefingBackend({ from } as never);
    const since = '2026-03-22T00:00:00Z';

    await backend.listRunsSince(since);

    expect(from).toHaveBeenCalledWith('runs');
    expect(select).toHaveBeenCalledWith('*');
    expect(gte).toHaveBeenCalledWith('updated_at', since);
  });

  it('returns null when the previous briefing query has no row', async () => {
    const single = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: 'none' } }),
    );
    const limit = vi.fn(() => ({ single }));
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const backend = createSupabaseBriefingBackend({ from } as never);

    await expect(backend.getPreviousBriefing()).resolves.toBeNull();
  });
});
