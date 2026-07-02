import { readFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResultsRecord } from '../types.js';
import { appendResult } from './results.js';
import { createReleaseProposal } from './release.js';

// packages/daemon/src/control-plane/ -> repo root is four levels up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const makeRecord = (
  issueNumber: number,
  overrides: Partial<ResultsRecord> = {},
): ResultsRecord => ({
  issueNumber,
  startedAt: '2026-07-02T08:00:00.000Z',
  completedAt: '2026-07-02T10:00:00.000Z',
  variant: 'feature',
  totalCost: 1.25,
  phasesExecuted: ['detect', 'implement', 'review', 'report'],
  fixAttemptCount: 0,
  outcome: 'complete',
  ...overrides,
});

function readRootConfig(): { branches: { staging: string; production: string } } {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'auto-claude.config.json'), 'utf8'),
  ) as { branches: { staging: string; production: string } };
}

describe('phase 0 gate G3: single-trunk release config', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'phase0-single-trunk-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('uses main/main and does not reference the retired dev branch', () => {
    const config = readRootConfig();

    expect(config.branches).toEqual({
      staging: 'main',
      production: 'main',
    });
    expect(Object.values(config.branches)).not.toContain('dev');
  });

  it('does not create a release PR when staging and production are the same trunk', async () => {
    await appendResult(makeRecord(774), stateDir);

    const octokit = {
      pulls: {
        create: vi.fn(async () => {
          throw new Error('single-trunk release must not create a PR');
        }),
      },
    };

    const result = await createReleaseProposal(
      octokit as never,
      'DANIELSOCRAHANDLEZZ',
      'auto-claude',
      'main',
      'main',
      stateDir,
    );

    expect(result).toMatchObject({
      status: 'single-trunk-not-applicable',
      issueCount: 1,
      totalCost: 1.25,
      title: 'Release: 1 issue',
    });
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });
});
