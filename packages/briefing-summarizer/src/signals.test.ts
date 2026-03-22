import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { collectSignals } from './signals.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'abc1234 fix: some commit\ndef5678 feat: another commit\n'),
}));

function createMockSupabase(overrides?: {
  runsData?: Record<string, unknown>[] | null;
  runsError?: { message: string } | null;
}) {
  const runsData = overrides?.runsData ?? [
    { id: 'run-1', issue_number: 42, outcome: 'success', updated_at: '2026-03-22T10:00:00Z' },
  ];
  const runsError = overrides?.runsError ?? null;

  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        gte: vi.fn(() => Promise.resolve({ data: runsData, error: runsError })),
      })),
    })),
  } as unknown as Parameters<typeof collectSignals>[0];
}

// Store original fetch
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectSignals', () => {
  it('collects all four signal sources successfully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: 'running', activeRuns: 2 }),
    }) as unknown as typeof fetch;

    const supabase = createMockSupabase();
    const result = await collectSignals(supabase, 'http://localhost:3847', '2026-03-22T00:00:00Z');

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ id: 'run-1' });
    expect(result.daemonStatus).toMatchObject({ state: 'running' });
    expect(result.gitLog).toHaveLength(2);
    expect(result.heartbeatAt).toBeTruthy();
    expect(result.gaps).toHaveLength(0);
  });

  it('handles runs query failure with gap note', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: 'running' }),
    }) as unknown as typeof fetch;

    const supabase = createMockSupabase({
      runsData: null,
      runsError: { message: 'connection refused' },
    });

    const result = await collectSignals(supabase, 'http://localhost:3847', '2026-03-22T00:00:00Z');

    expect(result.runs).toHaveLength(0);
    expect(result.gaps).toContainEqual(expect.stringContaining('runs:'));
    // Other signals still collected
    expect(result.daemonStatus).toBeTruthy();
    expect(result.gitLog).toHaveLength(2);
  });

  it('handles daemon fetch failure with gap note', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const supabase = createMockSupabase();
    const result = await collectSignals(supabase, 'http://localhost:3847', '2026-03-22T00:00:00Z');

    // Daemon returns null on fetch failure (caught internally), not a rejection
    expect(result.daemonStatus).toBeNull();
    expect(result.heartbeatAt).toBeNull();
    // Runs and git log still collected
    expect(result.runs).toHaveLength(1);
    expect(result.gitLog).toHaveLength(2);
  });

  it('handles git log failure with gap note', async () => {
    const { execSync } = await import('node:child_process');
    (execSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ state: 'running' }),
    }) as unknown as typeof fetch;

    const supabase = createMockSupabase();
    const result = await collectSignals(supabase, 'http://localhost:3847', '2026-03-22T00:00:00Z');

    expect(result.gitLog).toHaveLength(0);
    expect(result.gaps).toContainEqual(expect.stringContaining('git:'));
    // Other signals still collected
    expect(result.runs).toHaveLength(1);
    expect(result.daemonStatus).toBeTruthy();
  });

  it('produces multiple gap notes when multiple sources fail', async () => {
    const { execSync } = await import('node:child_process');
    (execSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const supabase = createMockSupabase({
      runsData: null,
      runsError: { message: 'timeout' },
    });

    const result = await collectSignals(supabase, 'http://localhost:3847', '2026-03-22T00:00:00Z');

    expect(result.runs).toHaveLength(0);
    expect(result.daemonStatus).toBeNull();
    expect(result.gitLog).toHaveLength(0);
    expect(result.gaps.length).toBeGreaterThanOrEqual(2);
  });
});
