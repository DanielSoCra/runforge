import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

const mocks = vi.hoisted(() => ({
  requireDashboardUser: vi.fn(),
  readLatestBriefing: vi.fn(),
  listActiveRuns: vi.fn(),
  listAttentionRuns: vi.fn(),
  listActivityEvents: vi.fn(),
  listBoardInputs: vi.fn(),
  readCredential: vi.fn(),
}));

vi.mock('@/lib/auth/require-session', () => ({
  requireDashboardUser: mocks.requireDashboardUser,
}));

vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    briefings: {
      readLatestBriefing: mocks.readLatestBriefing,
      listActiveRuns: mocks.listActiveRuns,
      listAttentionRuns: mocks.listAttentionRuns,
      listActivityEvents: mocks.listActivityEvents,
    },
    issues: {
      listBoardInputs: mocks.listBoardInputs,
    },
    githubConnections: {
      readCredential: mocks.readCredential,
    },
  }),
}));

import { requireDashboardUser } from '@/lib/auth/require-session';

import {
  getActiveRuns,
  getActivityFeed,
  getLatestBriefing,
  getNeedsAttention,
  getUpNext,
  refreshLivePanels,
} from './briefing';

const mockFetch = vi.fn();

let savedGithubToken: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireDashboardUser.mockResolvedValue({
    user: { id: 'viewer-1', email: 'viewer@test.com', role: 'viewer' },
  });
  mocks.readLatestBriefing.mockResolvedValue({ ok: false, error: 'not-found', message: 'none' });
  mocks.listActiveRuns.mockResolvedValue({ ok: true, value: [] });
  mocks.listAttentionRuns.mockResolvedValue({ ok: true, value: [] });
  mocks.listActivityEvents.mockResolvedValue({ ok: true, value: [] });
  mocks.listBoardInputs.mockResolvedValue({ ok: true, value: { repos: [], runs: [] } });
  mocks.readCredential.mockResolvedValue({
    ok: false,
    error: 'not-found',
    message: 'missing connection',
  });
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
  savedGithubToken = process.env.GITHUB_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedGithubToken !== undefined) {
    process.env.GITHUB_TOKEN = savedGithubToken;
  } else {
    delete process.env.GITHUB_TOKEN;
  }
});

function ok<T>(value: T) {
  return { ok: true, value };
}

function unavailable(message = 'database unavailable') {
  return { ok: false, error: 'unavailable', message };
}

function briefing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    status_line: 'All systems nominal',
    changes: [],
    attention: [],
    forecast: 'Clear',
    signal_snapshot: {},
    generated_at: '2026-03-22T10:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    repo_owner: 'acme',
    repo_name: 'web',
    issue_number: 42,
    issue_title: 'Fix login',
    current_phase: 'implementation',
    outcome: 'in-progress',
    total_cost: 1.5,
    started_at: '2026-03-22T08:00:00.000Z',
    phases: [],
    ...overrides,
  };
}

function repo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    owner: 'acme',
    name: 'web',
    connectionId: null,
    ...overrides,
  };
}

function boardInputs(
  repos: Array<ReturnType<typeof repo>>,
  runs: Array<Record<string, unknown>> = [],
) {
  mocks.listBoardInputs.mockResolvedValueOnce(ok({ repos, runs }));
}

function setupGitHubIssuesResponse(
  issues: Array<{
    number: number;
    title: string;
    html_url?: string;
    labels: Array<{ name: string } | string>;
    pull_request?: unknown;
  }>,
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => issues,
  } as Response);
}

describe('getLatestBriefing', () => {
  it('returns the latest briefing row from the app-owned store', async () => {
    const latest = briefing();
    mocks.readLatestBriefing.mockResolvedValueOnce(ok(latest));

    const result = await getLatestBriefing();

    expect(requireDashboardUser).toHaveBeenCalledTimes(1);
    expect(mocks.readLatestBriefing).toHaveBeenCalledTimes(1);
    expect(result).toEqual(latest);
  });

  it('returns null when no briefings exist', async () => {
    const result = await getLatestBriefing();

    expect(result).toBeNull();
  });

  it('throws when the briefing store is unavailable', async () => {
    mocks.readLatestBriefing.mockResolvedValueOnce(unavailable());

    await expect(getLatestBriefing()).rejects.toThrow(
      'Failed to fetch latest briefing',
    );
  });
});

describe('getActiveRuns', () => {
  it('returns in-progress runs', async () => {
    const runs = [run()];
    mocks.listActiveRuns.mockResolvedValueOnce(ok(runs));

    const result = await getActiveRuns();

    expect(mocks.listActiveRuns).toHaveBeenCalledTimes(1);
    expect(result).toEqual(runs);
  });

  it('deduplicates retries by issue and keeps the latest run', async () => {
    const older = run({ id: 'old', started_at: '2026-03-22T08:00:00.000Z' });
    const latest = run({ id: 'new', started_at: '2026-03-22T09:00:00.000Z' });
    mocks.listActiveRuns.mockResolvedValueOnce(ok([older, latest]));

    const result = await getActiveRuns();

    expect(result).toEqual([latest]);
  });

  it('returns empty array when no active runs exist', async () => {
    const result = await getActiveRuns();

    expect(result).toEqual([]);
  });

  it('throws when the active run store query fails', async () => {
    mocks.listActiveRuns.mockResolvedValueOnce(unavailable());

    await expect(getActiveRuns()).rejects.toThrow(
      'Failed to fetch active runs',
    );
  });
});

describe('getNeedsAttention', () => {
  it('sorts all three tiers correctly: blocked > review > failure (SPEC-63 regression, #442)', async () => {
    mocks.listAttentionRuns.mockResolvedValueOnce(
      ok([
        run({ id: 'failed', issue_number: 30, outcome: 'failed' }),
        run({ id: 'escalated', issue_number: 20, outcome: 'escalated' }),
        run({ id: 'stuck', issue_number: 10, outcome: 'stuck' }),
      ]),
    );

    const result = await getNeedsAttention();

    expect(result).toHaveLength(3);
    expect(result[0].reason).toBe('blocked');
    expect(result[0].issueNumber).toBe(10);
    expect(result[1].reason).toBe('review');
    expect(result[1].issueNumber).toBe(20);
    expect(result[2].reason).toBe('failure');
    expect(result[2].issueNumber).toBe(30);
  });

  it('adds actionable GitHub issue links', async () => {
    mocks.listAttentionRuns.mockResolvedValueOnce(
      ok([run({ issue_number: 10, outcome: 'stuck' })]),
    );

    const result = await getNeedsAttention();

    expect(result[0].actionLinks).toEqual([
      { label: 'View Issue', url: 'https://github.com/acme/web/issues/10' },
    ]);
  });

  it('keeps the more urgent reason when retries share an issue', async () => {
    mocks.listAttentionRuns.mockResolvedValueOnce(
      ok([
        run({ id: 'failed', issue_number: 10, outcome: 'failed' }),
        run({ id: 'stuck', issue_number: 10, outcome: 'stuck' }),
      ]),
    );

    const result = await getNeedsAttention();

    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('blocked');
  });

  it('keeps the latest run when retries have the same urgency', async () => {
    const older = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const latest = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mocks.listAttentionRuns.mockResolvedValueOnce(
      ok([
        run({ id: 'older', issue_number: 10, outcome: 'stuck', started_at: older }),
        run({ id: 'latest', issue_number: 10, outcome: 'stuck', started_at: latest }),
      ]),
    );

    const result = await getNeedsAttention();

    expect(result).toHaveLength(1);
    expect(result[0].waitDuration).toBe('2h');
  });

  it('returns empty array when nothing needs attention', async () => {
    const result = await getNeedsAttention();

    expect(result).toEqual([]);
  });

  it('throws when the attention store query fails', async () => {
    mocks.listAttentionRuns.mockResolvedValueOnce(unavailable());

    await expect(getNeedsAttention()).rejects.toThrow(
      'Failed to fetch attention runs',
    );
  });
});

describe('getUpNext', () => {
  it('returns issues with pipeline labels sorted by priority', async () => {
    boardInputs([repo()]);
    process.env.GITHUB_TOKEN = 'test-token';
    setupGitHubIssuesResponse([
      {
        number: 10,
        title: 'L1 approved',
        labels: [{ name: 'feature-pipeline' }, { name: 'l1-approved' }],
      },
      {
        number: 20,
        title: 'Ready to implement',
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
      {
        number: 30,
        title: 'L3 approved',
        labels: [{ name: 'feature-pipeline' }, { name: 'l3-approved' }],
      },
    ]);

    const result = await getUpNext();

    expect(result.map((item) => item.issueNumber)).toEqual([20, 30, 10]);
  });

  it('reads visible repos through the app-owned issue store before credential lookup', async () => {
    boardInputs([repo({ connectionId: 'conn-1' })]);
    mocks.readCredential.mockResolvedValueOnce(
      ok({ githubLogin: 'acme', token: 'repo-token' }),
    );
    setupGitHubIssuesResponse([
      {
        number: 20,
        title: 'Ready',
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
    ]);

    const result = await getUpNext();

    expect(mocks.listBoardInputs).toHaveBeenCalledTimes(1);
    expect(mocks.readCredential).toHaveBeenCalledWith('conn-1');
    expect(result).toHaveLength(1);
  });

  it('deduplicates credential reads for repos sharing a connection', async () => {
    boardInputs([
      repo({ id: 'r1', name: 'web', connectionId: 'conn-1' }),
      repo({ id: 'r2', name: 'api', connectionId: 'conn-1' }),
    ]);
    mocks.readCredential.mockResolvedValue(
      ok({ githubLogin: 'acme', token: 'shared-token' }),
    );
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 20,
            title: 'Ready web',
            labels: [
              { name: 'feature-pipeline' },
              { name: 'ready-to-implement' },
            ],
          },
        ],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            number: 30,
            title: 'Ready api',
            labels: [
              { name: 'feature-pipeline' },
              { name: 'ready-to-implement' },
            ],
          },
        ],
      } as Response);

    const result = await getUpNext();

    expect(mocks.readCredential).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.map((item) => `${item.repoName}#${item.issueNumber}`)).toEqual([
      'web#20',
      'api#30',
    ]);
  });

  it('excludes issues that have in-progress runs', async () => {
    boardInputs(
      [repo()],
      [
        {
          issue_number: 20,
          repo_owner: 'acme',
          repo_name: 'web',
          issue_title: 'Already running',
          outcome: 'in-progress',
          current_phase: 'implementation',
        },
      ],
    );
    process.env.GITHUB_TOKEN = 'test-token';
    setupGitHubIssuesResponse([
      {
        number: 20,
        title: 'Already running',
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
      {
        number: 30,
        title: 'Queued',
        labels: [{ name: 'feature-pipeline' }, { name: 'l3-approved' }],
      },
    ]);

    const result = await getUpNext();

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(30);
  });

  it('returns empty array when no repos are enabled', async () => {
    const result = await getUpNext();

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips repos without a GitHub token', async () => {
    boardInputs([repo()]);
    delete process.env.GITHUB_TOKEN;

    const result = await getUpNext();

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to GITHUB_TOKEN when a connection credential is unavailable', async () => {
    boardInputs([repo({ connectionId: 'conn-1' })]);
    process.env.GITHUB_TOKEN = 'fallback-token';
    setupGitHubIssuesResponse([
      {
        number: 20,
        title: 'Ready',
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
    ]);

    const result = await getUpNext();

    expect(mocks.readCredential).toHaveBeenCalledWith('conn-1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/web/issues?state=open&labels=feature-pipeline&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fallback-token',
        }),
      }),
    );
    expect(result).toHaveLength(1);
  });

  it('excludes pull requests, non-pipeline issues, and issues with active labels', async () => {
    boardInputs([repo()]);
    process.env.GITHUB_TOKEN = 'test-token';
    setupGitHubIssuesResponse([
      {
        number: 10,
        title: 'Pull request',
        pull_request: {},
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
      { number: 20, title: 'Bug', labels: [{ name: 'bug' }] },
      {
        number: 30,
        title: 'Active',
        labels: ['feature-pipeline', 'implementing'],
      },
      {
        number: 40,
        title: 'Queued',
        labels: ['feature-pipeline', 'ready-to-implement'],
      },
    ]);

    const result = await getUpNext();

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(40);
  });

  it('returns an empty repo result when the GitHub request fails', async () => {
    boardInputs([repo()]);
    process.env.GITHUB_TOKEN = 'test-token';
    mockFetch.mockResolvedValueOnce({ ok: false } as Response);

    const result = await getUpNext();

    expect(result).toEqual([]);
  });

  it('throws when board inputs cannot be read (ERR-32 regression, #388)', async () => {
    mocks.listBoardInputs.mockResolvedValueOnce(unavailable());

    await expect(getUpNext()).rejects.toThrow(
      'Failed to fetch repos for up-next',
    );
  });
});

describe('getActivityFeed', () => {
  it('returns recent activity events with default page size', async () => {
    const events = [
      {
        id: 'e-1',
        occurred_at: '2026-03-22T10:00:00.000Z',
        event_type: 'state-transition',
        severity: 'info',
        summary: 'Run started',
        links: [],
      },
    ];
    mocks.listActivityEvents.mockResolvedValueOnce(ok(events));

    const result = await getActivityFeed();

    expect(mocks.listActivityEvents).toHaveBeenCalledWith({
      cursor: undefined,
      pageSize: 50,
    });
    expect(result).toEqual(events);
  });

  it('passes cursor and custom page size to the store', async () => {
    await getActivityFeed({
      cursor: '2026-03-22T00:00:00.000Z',
      pageSize: 10,
    });

    expect(mocks.listActivityEvents).toHaveBeenCalledWith({
      cursor: '2026-03-22T00:00:00.000Z',
      pageSize: 10,
    });
  });

  it('throws when the activity store query fails', async () => {
    mocks.listActivityEvents.mockResolvedValueOnce(unavailable());

    await expect(getActivityFeed()).rejects.toThrow(
      'Failed to fetch activity feed',
    );
  });
});

describe('refreshLivePanels', () => {
  it('returns all live panel data after one auth check', async () => {
    const activeRun = run();
    mocks.listActiveRuns.mockResolvedValueOnce(ok([activeRun]));
    mocks.listAttentionRuns.mockResolvedValueOnce(
      ok([run({ id: 'stuck', issue_number: 10, outcome: 'stuck' })]),
    );
    boardInputs([repo()]);
    process.env.GITHUB_TOKEN = 'test-token';
    setupGitHubIssuesResponse([
      {
        number: 20,
        title: 'Queued',
        labels: [
          { name: 'feature-pipeline' },
          { name: 'ready-to-implement' },
        ],
      },
    ]);

    const result = await refreshLivePanels();

    expect(requireDashboardUser).toHaveBeenCalledTimes(1);
    expect(result.activeRuns).toEqual([activeRun]);
    expect(result.needsAttention[0].reason).toBe('blocked');
    expect(result.upNext[0].issueNumber).toBe(20);
  });
});

describe('requireDashboardUser guard (SEC-25 regression, auth required)', () => {
  it('every exported server action checks auth before querying', async () => {
    mocks.requireDashboardUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(getLatestBriefing()).rejects.toThrow('Unauthorized');
    await expect(getActiveRuns()).rejects.toThrow('Unauthorized');
    await expect(getNeedsAttention()).rejects.toThrow('Unauthorized');
    await expect(getUpNext()).rejects.toThrow('Unauthorized');
    await expect(getActivityFeed()).rejects.toThrow('Unauthorized');
    await expect(refreshLivePanels()).rejects.toThrow('Unauthorized');

    expect(requireDashboardUser).toHaveBeenCalledTimes(6);
    expect(mocks.readLatestBriefing).not.toHaveBeenCalled();
    expect(mocks.listActiveRuns).not.toHaveBeenCalled();
    expect(mocks.listAttentionRuns).not.toHaveBeenCalled();
    expect(mocks.listActivityEvents).not.toHaveBeenCalled();
    expect(mocks.listBoardInputs).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('viewer access (SPEC-38 / #273 regression)', () => {
  it('briefing actions allow authenticated viewers', async () => {
    mocks.requireDashboardUser.mockResolvedValueOnce({
      user: { id: 'viewer-1', email: 'viewer@test.com', role: 'viewer' },
    });

    const result = await getLatestBriefing();

    expect(result).toBeNull();
    expect(requireDashboardUser).toHaveBeenCalledTimes(1);
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
