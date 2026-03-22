import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase client
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: mockFrom,
  }),
}));

// Mock service client for getUpNext (needs service-role to decrypt tokens)
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

// Mock fetch for GitHub API calls
const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  mockFrom.mockReset();
  mockServiceFrom.mockReset();
  mockServiceRpc.mockReset();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getLatestBriefing', () => {
  it('returns the latest briefing row', async () => {
    const briefing = {
      id: 'b-1',
      status_line: 'All systems nominal',
      changes: [],
      attention: [],
      forecast: 'Clear skies',
      signal_snapshot: {},
      generated_at: '2026-03-22T10:00:00Z',
    };
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: briefing, error: null }),
          }),
        }),
      }),
    });

    const { getLatestBriefing } = await import('./briefing');
    const result = await getLatestBriefing();

    expect(mockFrom).toHaveBeenCalledWith('briefings');
    expect(result).toEqual(briefing);
  });

  it('returns null when no briefings exist', async () => {
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    });

    const { getLatestBriefing } = await import('./briefing');
    const result = await getLatestBriefing();

    expect(result).toBeNull();
  });
});

describe('getActiveRuns', () => {
  it('returns runs with outcome in-progress', async () => {
    const runs = [
      {
        id: 'r-1',
        repo_owner: 'acme',
        repo_name: 'web',
        issue_number: 42,
        issue_title: 'Fix login',
        current_phase: 'implementation',
        outcome: 'in-progress',
        total_cost: 1.5,
        started_at: '2026-03-22T08:00:00Z',
        phases: [],
      },
    ];
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: runs, error: null }),
        }),
      }),
    });

    const { getActiveRuns } = await import('./briefing');
    const result = await getActiveRuns();

    expect(mockFrom).toHaveBeenCalledWith('runs');
    expect(result).toEqual(runs);
  });

  it('returns empty array when no active runs', async () => {
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });

    const { getActiveRuns } = await import('./briefing');
    const result = await getActiveRuns();

    expect(result).toEqual([]);
  });
});

describe('getNeedsAttention', () => {
  it('returns items sorted by urgency: blocked > review', async () => {
    const stuckRuns = [
      {
        id: 'r-stuck',
        repo_owner: 'acme',
        repo_name: 'web',
        issue_number: 10,
        issue_title: 'Stuck issue',
        outcome: 'stuck',
        started_at: '2026-03-20T10:00:00Z',
      },
    ];
    const escalatedRuns = [
      {
        id: 'r-esc',
        repo_owner: 'acme',
        repo_name: 'api',
        issue_number: 20,
        issue_title: 'Escalated issue',
        outcome: 'escalated',
        started_at: '2026-03-21T10:00:00Z',
      },
    ];

    // First call: stuck runs
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: stuckRuns, error: null }),
      }),
    });
    // Second call: escalated runs
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: escalatedRuns, error: null }),
      }),
    });

    const { getNeedsAttention } = await import('./briefing');
    const result = await getNeedsAttention();

    expect(result).toHaveLength(2);
    // blocked items come first
    expect(result[0].reason).toBe('blocked');
    expect(result[0].issueNumber).toBe(10);
    expect(result[0].actionLinks[0].url).toBe('https://github.com/acme/web/issues/10');
    // review items come second
    expect(result[1].reason).toBe('review');
    expect(result[1].issueNumber).toBe(20);
    expect(result[1].actionLinks[0].url).toBe('https://github.com/acme/api/issues/20');
  });

  it('returns empty array when nothing needs attention', async () => {
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    const { getNeedsAttention } = await import('./briefing');
    const result = await getNeedsAttention();

    expect(result).toEqual([]);
  });

  it('includes waitDuration as human-readable string', async () => {
    const stuckRuns = [
      {
        id: 'r-stuck',
        repo_owner: 'acme',
        repo_name: 'web',
        issue_number: 10,
        issue_title: 'Stuck issue',
        outcome: 'stuck',
        started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      },
    ];
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: stuckRuns, error: null }),
      }),
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    const { getNeedsAttention } = await import('./briefing');
    const result = await getNeedsAttention();

    expect(result[0].waitDuration).toBe('2h');
  });
});

describe('getUpNext', () => {
  function setupReposQuery(repos: Array<{ id: string; owner: string; name: string; connection_id: string | null }>) {
    mockServiceFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockResolvedValue({ data: repos, error: null }),
        }),
      }),
    });
  }

  function setupActiveRunsQuery(runs: Array<{ issue_number: number; repo_owner: string; repo_name: string }>) {
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: runs, error: null }),
      }),
    });
  }

  function setupGitHubIssuesResponse(issues: Array<{ number: number; title: string; html_url: string; labels: Array<{ name: string }> }>) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => issues,
    } as Response);
  }

  it('returns issues with pipeline labels sorted by priority', async () => {
    setupReposQuery([{ id: 'r1', owner: 'acme', name: 'web', connection_id: null }]);
    setupActiveRunsQuery([]);
    // Mock GITHUB_TOKEN env
    process.env.GITHUB_TOKEN = 'test-token';

    setupGitHubIssuesResponse([
      { number: 10, title: 'L1 approved', html_url: 'https://github.com/acme/web/issues/10', labels: [{ name: 'feature-pipeline' }, { name: 'l1-approved' }] },
      { number: 20, title: 'Ready to implement', html_url: 'https://github.com/acme/web/issues/20', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
      { number: 30, title: 'L3 approved', html_url: 'https://github.com/acme/web/issues/30', labels: [{ name: 'feature-pipeline' }, { name: 'l3-approved' }] },
    ]);

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    // Should be sorted: ready-to-implement > l3-approved > l2-approved > l1-approved
    expect(result).toHaveLength(3);
    expect(result[0].pipelineLabel).toBe('ready-to-implement');
    expect(result[0].issueNumber).toBe(20);
    expect(result[1].pipelineLabel).toBe('l3-approved');
    expect(result[1].issueNumber).toBe(30);
    expect(result[2].pipelineLabel).toBe('l1-approved');
    expect(result[2].issueNumber).toBe(10);

    delete process.env.GITHUB_TOKEN;
  });

  it('excludes issues that have in-progress runs', async () => {
    setupReposQuery([{ id: 'r1', owner: 'acme', name: 'web', connection_id: null }]);
    setupActiveRunsQuery([{ issue_number: 20, repo_owner: 'acme', repo_name: 'web' }]);
    process.env.GITHUB_TOKEN = 'test-token';

    setupGitHubIssuesResponse([
      { number: 20, title: 'Already running', html_url: 'https://github.com/acme/web/issues/20', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
      { number: 30, title: 'Queued', html_url: 'https://github.com/acme/web/issues/30', labels: [{ name: 'feature-pipeline' }, { name: 'l3-approved' }] },
    ]);

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(30);

    delete process.env.GITHUB_TOKEN;
  });

  it('returns empty array when no repos are enabled', async () => {
    setupReposQuery([]);
    setupActiveRunsQuery([]);

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    expect(result).toEqual([]);
  });

  it('skips repos without a GitHub token', async () => {
    setupReposQuery([{ id: 'r1', owner: 'acme', name: 'web', connection_id: null }]);
    setupActiveRunsQuery([]);
    // No GITHUB_TOKEN env var, no connection_id → no token
    delete process.env.GITHUB_TOKEN;

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    expect(result).toEqual([]);
    // Should not have called GitHub API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('excludes issues without feature-pipeline label', async () => {
    setupReposQuery([{ id: 'r1', owner: 'acme', name: 'web', connection_id: null }]);
    setupActiveRunsQuery([]);
    process.env.GITHUB_TOKEN = 'test-token';

    setupGitHubIssuesResponse([
      { number: 10, title: 'Not pipeline', html_url: 'https://github.com/acme/web/issues/10', labels: [{ name: 'bug' }] },
      { number: 20, title: 'Pipeline issue', html_url: 'https://github.com/acme/web/issues/20', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
    ]);

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(20);

    delete process.env.GITHUB_TOKEN;
  });

  it('excludes issues with implementing label (already being worked on)', async () => {
    setupReposQuery([{ id: 'r1', owner: 'acme', name: 'web', connection_id: null }]);
    setupActiveRunsQuery([]);
    process.env.GITHUB_TOKEN = 'test-token';

    setupGitHubIssuesResponse([
      { number: 10, title: 'Being implemented', html_url: 'https://github.com/acme/web/issues/10', labels: [{ name: 'feature-pipeline' }, { name: 'implementing' }] },
      { number: 20, title: 'Queued', html_url: 'https://github.com/acme/web/issues/20', labels: [{ name: 'feature-pipeline' }, { name: 'ready-to-implement' }] },
    ]);

    const { getUpNext } = await import('./briefing');
    const result = await getUpNext();

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(20);

    delete process.env.GITHUB_TOKEN;
  });
});

describe('getActivityFeed', () => {
  it('returns recent activity events with default page size', async () => {
    const events = [
      {
        id: 'e-1',
        occurred_at: '2026-03-22T10:00:00Z',
        event_type: 'run_started',
        severity: 'info',
        summary: 'Run started',
        links: [],
      },
    ];
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: events, error: null }),
        }),
      }),
    });

    const { getActivityFeed } = await import('./briefing');
    const result = await getActivityFeed();

    expect(mockFrom).toHaveBeenCalledWith('activity_events');
    expect(result).toEqual(events);
  });

  it('uses cursor to paginate', async () => {
    const events = [
      {
        id: 'e-2',
        occurred_at: '2026-03-21T10:00:00Z',
        event_type: 'run_completed',
        severity: 'info',
        summary: 'Run completed',
        links: [],
      },
    ];
    const ltMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data: events, error: null }),
    });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          lt: ltMock,
        }),
      }),
    });

    const { getActivityFeed } = await import('./briefing');
    const result = await getActivityFeed({ cursor: '2026-03-22T00:00:00Z' });

    expect(ltMock).toHaveBeenCalledWith('occurred_at', '2026-03-22T00:00:00Z');
    expect(result).toEqual(events);
  });

  it('respects custom pageSize', async () => {
    const limitMock = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: limitMock,
        }),
      }),
    });

    const { getActivityFeed } = await import('./briefing');
    await getActivityFeed({ pageSize: 10 });

    expect(limitMock).toHaveBeenCalledWith(10);
  });
});

describe('formatDuration', () => {
  it('formats minutes', async () => {
    const { formatDuration } = await import('../lib/format');
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(formatDuration(thirtyMinsAgo)).toBe('30m');
  });

  it('formats hours', async () => {
    const { formatDuration } = await import('../lib/format');
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(formatDuration(fiveHoursAgo)).toBe('5h');
  });

  it('formats days', async () => {
    const { formatDuration } = await import('../lib/format');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatDuration(threeDaysAgo)).toBe('3d');
  });

  it('shows <1m for very recent timestamps', async () => {
    const { formatDuration } = await import('../lib/format');
    const justNow = new Date(Date.now() - 10 * 1000).toISOString();
    expect(formatDuration(justNow)).toBe('<1m');
  });
});
