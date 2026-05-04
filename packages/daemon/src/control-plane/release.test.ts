// src/control-plane/release.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendResult } from './results.js';
import { aggregateReleaseNotes, createReleaseProposal } from './release.js';
import type { ResultsRecord } from '../types.js';

const makeRecord = (
  issueNumber: number,
  overrides: Partial<ResultsRecord> = {},
): ResultsRecord => ({
  issueNumber,
  startedAt: '2026-03-19T08:00:00.000Z',
  completedAt: '2026-03-19T10:00:00.000Z',
  variant: 'feature',
  totalCost: 1.50,
  phasesExecuted: ['detect', 'implement', 'review', 'report'],
  fixAttemptCount: 0,
  outcome: 'complete',
  ...overrides,
});

describe('createReleaseProposal', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'release-proposal-'));
  });

  it('returns no-completed-work without creating a PR when no completed results exist', async () => {
    const octokit = {
      pulls: { create: vi.fn() },
    };

    const result = await createReleaseProposal(
      octokit as never,
      'DANIELSOCRAHANDLEZZ',
      'auto-claude',
      'dev',
      'main',
      stateDir,
    );

    expect(result.status).toBe('no-completed-work');
    expect(result.issueCount).toBe(0);
    expect(octokit.pulls.create).not.toHaveBeenCalled();
  });

  it('creates a staging-to-production PR with aggregated release notes', async () => {
    await appendResult(makeRecord(519, { totalCost: 1.25 }), stateDir);
    const octokit = {
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: {
            number: 42,
            html_url: 'https://github.com/DANIELSOCRAHANDLEZZ/auto-claude/pull/42',
          },
        }),
      },
    };

    const result = await createReleaseProposal(
      octokit as never,
      'DANIELSOCRAHANDLEZZ',
      'auto-claude',
      'dev',
      'main',
      stateDir,
    );

    expect(result).toMatchObject({
      status: 'success',
      prNumber: 42,
      prUrl: 'https://github.com/DANIELSOCRAHANDLEZZ/auto-claude/pull/42',
      issueCount: 1,
      totalCost: 1.25,
    });
    expect(octokit.pulls.create).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'DANIELSOCRAHANDLEZZ',
      repo: 'auto-claude',
      head: 'dev',
      base: 'main',
      title: 'Release: 1 issue',
      body: expect.stringContaining('#519:'),
    }));
  });
});

describe('aggregateReleaseNotes', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'release-'));
  });

  it('returns empty release notes when no results exist', async () => {
    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.issueCount).toBe(0);
    expect(notes.totalCost).toBe(0);
    expect(notes.title).toBe('Release: 0 issues');
    expect(notes.body).toContain('_No completed issues since last release._');
  });

  it('generates notes from completed results', async () => {
    await appendResult(makeRecord(1, { totalCost: 1.00 }), stateDir);
    await appendResult(makeRecord(2, { totalCost: 2.50 }), stateDir);

    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.issueCount).toBe(2);
    expect(notes.totalCost).toBeCloseTo(3.50);
    expect(notes.title).toBe('Release: 2 issues');
    expect(notes.body).toContain('#1:');
    expect(notes.body).toContain('#2:');
    expect(notes.body).toContain('$1.00');
    expect(notes.body).toContain('$2.50');
    expect(notes.body).toContain('$3.50');
  });

  it('uses singular "issue" when count is 1', async () => {
    await appendResult(makeRecord(42), stateDir);
    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.title).toBe('Release: 1 issue');
  });

  it('excludes non-complete outcomes', async () => {
    await appendResult(makeRecord(1, { outcome: 'complete' }), stateDir);
    await appendResult(makeRecord(2, { outcome: 'stuck' }), stateDir);
    await appendResult(makeRecord(3, { outcome: 'escalated' }), stateDir);

    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.issueCount).toBe(1);
    expect(notes.body).toContain('#1:');
    expect(notes.body).not.toContain('#2:');
    expect(notes.body).not.toContain('#3:');
  });

  it('filters by completedAt date when since is provided', async () => {
    await appendResult(
      makeRecord(1, { completedAt: '2026-03-18T10:00:00.000Z' }),
      stateDir,
    );
    await appendResult(
      makeRecord(2, { completedAt: '2026-03-19T10:00:00.000Z' }),
      stateDir,
    );
    await appendResult(
      makeRecord(3, { completedAt: '2026-03-20T10:00:00.000Z' }),
      stateDir,
    );

    const notes = await aggregateReleaseNotes(stateDir, '2026-03-19T00:00:00.000Z');
    expect(notes.issueCount).toBe(2);
    expect(notes.body).not.toContain('#1:');
    expect(notes.body).toContain('#2:');
    expect(notes.body).toContain('#3:');
  });

  it('includes pipeline variant in issue list', async () => {
    await appendResult(makeRecord(7, { variant: 'bug', totalCost: 0.75 }), stateDir);
    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.body).toContain('bug pipeline');
  });

  it('includes standard release note sections', async () => {
    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.body).toContain('## Release Notes');
    expect(notes.body).toContain('**Issues completed:**');
    expect(notes.body).toContain('**Total cost:**');
    expect(notes.body).toContain('### Issues');
    expect(notes.body).toContain('_Generated by Auto-Claude_');
  });

  it('computes totalCost accurately across multiple records', async () => {
    await appendResult(makeRecord(1, { totalCost: 0.10 }), stateDir);
    await appendResult(makeRecord(2, { totalCost: 0.20 }), stateDir);
    await appendResult(makeRecord(3, { totalCost: 0.30 }), stateDir);

    const notes = await aggregateReleaseNotes(stateDir);
    expect(notes.totalCost).toBeCloseTo(0.60);
  });
});
