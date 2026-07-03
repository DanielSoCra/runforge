import { describe, expect, it, vi } from 'vitest';

import {
  PostgresRunWriter,
  toDbOutcome,
  toDbSessionType,
  toRunInsert,
  toRunPatch,
} from './run-writer.js';

describe('Postgres run writer mappings', () => {
  it('maps outcomes consistently with the existing DB contract', () => {
    expect(toDbOutcome('complete')).toBe('complete');
    expect(toDbOutcome('stuck')).toBe('stuck');
    expect(toDbOutcome('error')).toBe('failed');
    expect(toDbOutcome('failed')).toBe('failed');
    expect(toDbOutcome('parked')).toBe('in-progress');
    expect(toDbOutcome('paused')).toBe('in-progress');
  });

  it('maps session types to store session enum values', () => {
    expect(toDbSessionType('coordinator')).toBe('planning');
    expect(toDbSessionType('worker')).toBe('implementation');
    expect(toDbSessionType('reviewer-quality')).toBe('validation');
    expect(toDbSessionType('diagnostician')).toBe('diagnosis');
    expect(toDbSessionType('tech-lead')).toBe('planning');
  });

  it('maps snake_case run rows to the shared RunStore shape', () => {
    expect(
      toRunInsert('run-1', {
        repo_id: 'repo-1',
        repo_owner: 'org',
        repo_name: 'repo',
        issue_number: 42,
        issue_title: 'Build thing',
        current_phase: 'review',
        total_cost: 1.25,
        started_at: '2026-05-20T10:00:00Z',
        completed_at: null,
        active_plugins: ['plugin-a'],
      }),
    ).toMatchObject({
      id: 'run-1',
      repoId: 'repo-1',
      repoOwner: 'org',
      repoName: 'repo',
      issueNumber: 42,
      issueTitle: 'Build thing',
      currentPhase: 'review',
      totalCost: 1.25,
      completedAt: null,
      activePlugins: ['plugin-a'],
    });
  });

  it('omits undefined patch fields without dropping explicit nulls', () => {
    expect(
      toRunPatch({
        current_phase: undefined,
        completed_at: null,
        report: null,
      }),
    ).toEqual({
      completedAt: null,
      report: null,
    });
  });
});

describe('PostgresRunWriter', () => {
  it('writes runs and cost events through Store interfaces', async () => {
    const runs = {
      insertRun: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      updateRun: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const costs = {
      recordCostEvent: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const writer = new PostgresRunWriter(runs as never, costs as never);

    await writer.insertRun('run-1', {
      repo_owner: 'org',
      repo_name: 'repo',
      issue_number: 42,
      issue_title: 'Build thing',
    });
    await writer.upsertRun('run-1', { outcome: 'complete' });
    await writer.writeCostEvent('run-1', 'worker', 1.5);

    expect(runs.insertRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1', repoOwner: 'org' }),
    );
    expect(runs.updateRun).toHaveBeenCalledWith('run-1', {
      outcome: 'complete',
    });
    expect(costs.recordCostEvent).toHaveBeenCalledWith(
      'run-1',
      'implementation',
      1.5,
      undefined,
    );
  });

  it('passes spend attribution through to the CostEventStore (#810)', async () => {
    const runs = {
      insertRun: vi.fn(),
      updateRun: vi.fn(),
    };
    const costs = {
      recordCostEvent: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    };
    const writer = new PostgresRunWriter(runs as never, costs as never);

    await writer.writeCostEvent('run-1', 'worker', 1.5, {
      provider: 'claude-cli',
      usageUnits: 4321,
    });

    expect(costs.recordCostEvent).toHaveBeenCalledWith(
      'run-1',
      'implementation',
      1.5,
      { provider: 'claude-cli', usageUnits: 4321 },
    );
  });

  it('logs StoreResult failures without throwing', async () => {
    const runs = {
      insertRun: vi.fn().mockResolvedValue({
        ok: false,
        error: 'unavailable',
        message: 'db down',
      }),
      updateRun: vi.fn(),
    };
    const costs = { recordCostEvent: vi.fn() };
    const writer = new PostgresRunWriter(runs as never, costs as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      writer.insertRun('run-1', {
        repo_owner: 'org',
        repo_name: 'repo',
        issue_number: 42,
        issue_title: 'Build thing',
      }),
    ).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('insertRun failed'),
    );

    warn.mockRestore();
  });
});
