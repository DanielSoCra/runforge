// src/control-plane/phases-website.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunState } from '../types.js';
import type { AgencyConfig } from './agency-config.js';

// Mock checkpoint module
vi.mock('./checkpoint.js', () => ({
  shouldCheckpoint: vi.fn(),
  formatCheckpointComment: vi.fn(() => '## Checkpoint comment'),
}));

import { createWebsitePhaseHandlers } from './phases-website.js';
import { shouldCheckpoint, formatCheckpointComment } from './checkpoint.js';

const mockShouldCheckpoint = vi.mocked(shouldCheckpoint);
const mockFormatCheckpointComment = vi.mocked(formatCheckpointComment);

function makeConfig(overrides: Partial<AgencyConfig> = {}): AgencyConfig {
  return {
    client: 'test-client',
    language: 'en',
    stack: 'astro',
    deploy_target: 'github-pages',
    source_url: null,
    start_from: null,
    features: [],
    checkpoints: {
      intelligence: 'auto',
      brand: 'auto',
      design: 'auto',
      seo: 'auto',
      content: 'auto',
      assets: 'auto',
      build: 'auto',
      qa: 'auto',
      launch: 'auto',
    },
    ...overrides,
  };
}

function makeRun(): RunState {
  return {
    id: 'test-run',
    issueNumber: 10,
    title: 'Build website',
    phase: 'init',
    variant: 'website',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-03-21T00:00:00Z',
    updatedAt: '2026-03-21T00:00:00Z',
  };
}

function makeOctokit() {
  return {
    issues: {
      removeLabel: vi.fn(async () => {}),
      createComment: vi.fn(async () => {}),
      addLabels: vi.fn(async () => {}),
    },
  } as any;
}

describe('createWebsitePhaseHandlers', () => {
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = makeOctokit();
  });

  it('returns handlers for all 10 website phases', () => {
    const handlers = createWebsitePhaseHandlers(
      makeConfig(), null, octokit, 'owner', 'repo', 10, null,
    );
    const phases = ['init', 'intelligence', 'brand', 'design', 'seo', 'content', 'assets', 'build', 'qa', 'launch'] as const;
    for (const phase of phases) {
      expect(handlers[phase as keyof typeof handlers]).toBeTypeOf('function');
    }
  });

  describe('non-checkpoint phase (auto mode)', () => {
    it('returns success and removes checkpoint-paused label', async () => {
      mockShouldCheckpoint.mockReturnValue(false);
      const handlers = createWebsitePhaseHandlers(
        makeConfig(), null, octokit, 'owner', 'repo', 10, null,
      );
      const result = await handlers.brand!(makeRun());
      expect(result).toBe('success');
      // Should attempt to clean up checkpoint-paused label
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'checkpoint-paused' }),
      );
    });
  });

  describe('checkpoint phase', () => {
    it('posts comment, adds checkpoint-paused label, removes in-progress, returns budget-exceeded', async () => {
      mockShouldCheckpoint.mockReturnValue(true);
      mockFormatCheckpointComment.mockReturnValue('## Checkpoint');
      const handlers = createWebsitePhaseHandlers(
        makeConfig(), null, octokit, 'owner', 'repo', 10, null,
      );
      const result = await handlers.brand!(makeRun());
      expect(result).toBe('budget-exceeded');

      // Comment posted
      expect(octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          issue_number: 10,
          body: '## Checkpoint',
        }),
      );

      // Labels managed
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ['checkpoint-paused'] }),
      );
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'in-progress' }),
      );
    });

    it('saves start_from to supabase when supabase and repoId are provided', async () => {
      mockShouldCheckpoint.mockReturnValue(true);
      const mockUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            then: vi.fn((cb: any) => cb({ error: null })),
          }),
        }),
      });
      const mockSupabase = {
        from: vi.fn(() => ({ update: mockUpdate })),
      } as any;

      const config = makeConfig();
      const handlers = createWebsitePhaseHandlers(
        config, mockSupabase, octokit, 'owner', 'repo', 10, 'repo-123',
      );
      // Use 'brand' phase — next phase should be 'design'
      await handlers.brand!(makeRun());

      expect(mockSupabase.from).toHaveBeenCalledWith('repo_plugins');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ start_from: 'design' }),
        }),
      );
    });

    it('skips supabase update when supabase is null', async () => {
      mockShouldCheckpoint.mockReturnValue(true);
      const handlers = createWebsitePhaseHandlers(
        makeConfig(), null, octokit, 'owner', 'repo', 10, 'repo-123',
      );
      // Should not throw
      const result = await handlers.brand!(makeRun());
      expect(result).toBe('budget-exceeded');
    });

    it('skips supabase update when repoId is null', async () => {
      mockShouldCheckpoint.mockReturnValue(true);
      const mockSupabase = { from: vi.fn() } as any;
      const handlers = createWebsitePhaseHandlers(
        makeConfig(), mockSupabase, octokit, 'owner', 'repo', 10, null,
      );
      await handlers.brand!(makeRun());
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });
  });
});
