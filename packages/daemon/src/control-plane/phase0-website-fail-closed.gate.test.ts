import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import type { RunState } from '../types.js';
import type { AgencyConfig } from './agency-config.js';

vi.mock('./checkpoint.js', () => ({
  shouldCheckpoint: vi.fn(),
  formatCheckpointComment: vi.fn(() => '## Checkpoint comment'),
}));

import { shouldCheckpoint } from './checkpoint.js';
import { createWebsitePhaseHandlers } from './phases-website.js';

const mockShouldCheckpoint = vi.mocked(shouldCheckpoint);

function makeConfig(): AgencyConfig {
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
  };
}

function makeRun(): RunState {
  return {
    id: 'phase0-g2',
    issueNumber: 10,
    title: 'Build website',
    phase: 'brand',
    variant: 'website',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  };
}

function makeOctokit() {
  return {
    issues: {
      removeLabel: vi.fn(async () => {}),
      createComment: vi.fn(async () => {}),
      addLabels: vi.fn(async () => {}),
    },
  } as unknown as Octokit;
}

describe('phase 0 gate G2: website stubs fail closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldCheckpoint.mockReturnValue(false);
  });

  it('returns failure for a non-checkpoint phase and emits the structured stub error', async () => {
    const octokit = makeOctokit();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const handlers = createWebsitePhaseHandlers(
        makeConfig(),
        null,
        octokit,
        'owner',
        'repo',
        10,
        null,
      );

      const result = await handlers.brand!(makeRun());

      expect(result).toBe('failure');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[website\] phase brand has no real implementation.*failing closed \(stub\).*Plan 2/,
        ),
        expect.objectContaining({ issue: 10, phase: 'brand' }),
      );
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'checkpoint-paused' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
