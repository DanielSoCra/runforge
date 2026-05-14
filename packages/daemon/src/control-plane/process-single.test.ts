import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { processSingleIssue, resolveClaimAction, inferWorkType } from './process-single.js';

const {
  mockIssuesGet,
  mockLoadConfig,
  mockPreloadGovernanceContext,
  mockStateInitialize,
  mockProvisionLabels,
} = vi.hoisted(() => ({
  mockIssuesGet: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockPreloadGovernanceContext: vi.fn(),
  mockStateInitialize: vi.fn(),
  mockProvisionLabels: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    issues = {
      get: mockIssuesGet,
    };
  },
}));

vi.mock('../config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock('../session-runtime/governance-context.js', () => ({
  preloadGovernanceContext: (...args: unknown[]) => mockPreloadGovernanceContext(...args),
}));

vi.mock('../session-runtime/cost.js', () => ({
  CostTracker: class {},
}));

vi.mock('../session-runtime/runtime.js', () => ({
  SessionRuntime: class {},
}));

vi.mock('../implementation/coordinator.js', () => ({
  ImplementationCoordinator: class {},
}));

vi.mock('./state.js', () => ({
  StateManager: class {
    initialize = mockStateInitialize;
    saveRunState = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./phase-labels.js', () => ({
  createPhaseLabelMirror: () => ({
    provisionLabels: mockProvisionLabels,
  }),
}));

const originalGithubToken = process.env.GITHUB_TOKEN;

function makeConfig() {
  return {
    dailyBudget: 10,
    perRunBudget: 5,
    repo: { owner: 'owner', name: 'repo' },
    webhooks: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue({ ok: false, error: new Error('config not found') });
  mockPreloadGovernanceContext.mockResolvedValue(undefined);
  mockStateInitialize.mockResolvedValue(undefined);
  mockProvisionLabels.mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }
});

describe('resolveClaimAction', () => {
  it('returns bug-fix for bug variant', () => {
    const action = resolveClaimAction('bug', ['bug', 'review-finding']);
    expect(action).toEqual({ type: 'bug-fix' });
  });

  it('returns feature-pipeline with implementation for ready-to-implement', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline', 'ready-to-implement']);
    expect(action).toEqual({ type: 'feature-pipeline', workType: 'implementation' });
  });

  it('returns feature-pipeline with l3-generate for l2-approved', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline', 'l2-approved']);
    expect(action).toEqual({ type: 'feature-pipeline', workType: 'l3-generate' });
  });

  it('returns feature-pipeline with l2-brainstorm for l1-approved', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline', 'l1-approved']);
    expect(action).toEqual({ type: 'feature-pipeline', workType: 'l2-brainstorm' });
  });

  it('returns feature-pipeline with l2-brainstorm for l2-in-progress', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline', 'l2-in-progress']);
    expect(action).toEqual({ type: 'feature-pipeline', workType: 'l2-brainstorm' });
  });

  it('returns standard for spec-driven without feature-pipeline label', () => {
    const action = resolveClaimAction('spec-driven', ['ready']);
    expect(action).toEqual({ type: 'standard' });
  });

  it('returns standard for feature-simple variant', () => {
    const action = resolveClaimAction('feature-simple', ['ready']);
    expect(action).toEqual({ type: 'standard' });
  });

  it('returns standard for website variant', () => {
    const action = resolveClaimAction('website', ['website-init']);
    expect(action).toEqual({ type: 'standard' });
  });

  it('prefers ready-to-implement over l2-approved when both present', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline', 'ready-to-implement', 'l2-approved']);
    expect(action).toEqual({ type: 'feature-pipeline', workType: 'implementation' });
  });

  it('returns standard for spec-driven + feature-pipeline but no tier label', () => {
    const action = resolveClaimAction('spec-driven', ['feature-pipeline']);
    expect(action).toEqual({ type: 'standard' });
  });
});

describe('inferWorkType', () => {
  it('returns bug-fix for review-finding label', () => {
    expect(inferWorkType(['review-finding', 'P1'])).toBe('bug-fix');
  });

  it('returns implementation for feature-pipeline + ready-to-implement', () => {
    expect(inferWorkType(['feature-pipeline', 'ready-to-implement'])).toBe('implementation');
  });

  it('returns l3-generate for feature-pipeline + l2-approved', () => {
    expect(inferWorkType(['feature-pipeline', 'l2-approved'])).toBe('l3-generate');
  });

  it('returns l2-brainstorm for feature-pipeline + l1-approved', () => {
    expect(inferWorkType(['feature-pipeline', 'l1-approved'])).toBe('l2-brainstorm');
  });

  it('returns undefined for standard work labels', () => {
    expect(inferWorkType(['ready'])).toBeUndefined();
  });

  it('returns undefined for feature-pipeline without tier label', () => {
    expect(inferWorkType(['feature-pipeline'])).toBeUndefined();
  });

  it('review-finding takes priority over feature-pipeline', () => {
    expect(inferWorkType(['review-finding', 'feature-pipeline', 'ready-to-implement'])).toBe('bug-fix');
  });

  it('prefers ready-to-implement over l2-approved when both labels present', () => {
    expect(inferWorkType(['feature-pipeline', 'ready-to-implement', 'l2-approved'])).toBe('implementation');
  });

  it('prefers ready-to-implement over l1-approved when both labels present', () => {
    expect(inferWorkType(['feature-pipeline', 'ready-to-implement', 'l1-approved'])).toBe('implementation');
  });

  it('prefers l2-approved over l1-approved when both labels present', () => {
    expect(inferWorkType(['feature-pipeline', 'l2-approved', 'l1-approved'])).toBe('l3-generate');
  });

  it('prefers l2-approved over l2-in-progress when both labels present', () => {
    expect(inferWorkType(['feature-pipeline', 'l2-approved', 'l2-in-progress'])).toBe('l3-generate');
  });

  it('returns highest priority tier when all tier labels present', () => {
    expect(inferWorkType(['feature-pipeline', 'l1-approved', 'l2-in-progress', 'l2-approved', 'ready-to-implement'])).toBe('implementation');
  });
});

describe('processSingleIssue', () => {
  it('returns error when GITHUB_TOKEN is not set', async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await processSingleIssue(999, 'config.json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('GITHUB_TOKEN');
      }
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it('returns error for missing config', async () => {
    const result = await processSingleIssue(999, '/nonexistent/config.json');
    expect(result.ok).toBe(false);
  });

  it('returns error when GitHub issue fetch fails (#568)', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    mockLoadConfig.mockResolvedValue({ ok: true, value: makeConfig() });
    mockIssuesGet.mockRejectedValue(new Error('rate limited'));

    const result = await processSingleIssue(568, 'config.json');

    expect(mockIssuesGet).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 568,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('Failed to fetch issue #568: rate limited');
    }
  });
});
