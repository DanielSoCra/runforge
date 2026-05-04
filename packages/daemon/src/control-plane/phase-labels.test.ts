import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '../types.js';
import { createPhaseLabelMirror, PHASE_LABEL_MAP } from './phase-labels.js';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    issueNumber: 42,
    title: 'phase labels',
    phase: 'implement',
    variant: 'feature-simple',
    phaseCompletions: {},
    checkpoints: [],
    cost: 0,
    perRunBudget: 10,
    fixAttempts: [],
    errorHashes: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('PhaseLabelMirror', () => {
  it('maps only operator-visible FSM phases to phase labels (#469)', () => {
    expect(PHASE_LABEL_MAP).toMatchObject({
      classify: 'phase:classify',
      decompose: 'phase:decompose',
      implement: 'phase:implement',
      review: 'phase:review',
      holdout: 'phase:holdout',
      integrate: 'phase:integrate',
      deploy: 'phase:deploy',
      test: 'phase:test',
    });
    expect(PHASE_LABEL_MAP).not.toHaveProperty('detect');
    expect(PHASE_LABEL_MAP).not.toHaveProperty('report');
  });

  it('updates RunState, removes the old phase label, and adds the new label (#469)', async () => {
    const octokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
      },
    };
    const mirror = createPhaseLabelMirror(octokit as any, 'acme', 'web');
    const run = makeRun({ activePhaseLabel: 'phase:implement' });

    mirror.applyPhaseLabel(42, 'review', run);

    expect(run.activePhaseLabel).toBe('phase:review');
    await vi.waitFor(() => {
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'web',
        issue_number: 42,
        name: 'phase:implement',
      });
      expect(octokit.issues.addLabels).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'web',
        issue_number: 42,
        labels: ['phase:review'],
      });
    });
  });

  it('clears the active phase label without touching other labels (#469)', async () => {
    const octokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
      },
    };
    const mirror = createPhaseLabelMirror(octokit as any, 'acme', 'web');
    const run = makeRun({ activePhaseLabel: 'phase:test' });

    mirror.clearPhaseLabels(42, run);

    expect(run.activePhaseLabel).toBeUndefined();
    await vi.waitFor(() => {
      expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'web',
        issue_number: 42,
        name: 'phase:test',
      });
    });
    expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  });

  it('does not make a network call for unlabeled phases (#469)', async () => {
    const octokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
      },
    };
    const mirror = createPhaseLabelMirror(octokit as any, 'acme', 'web');
    const run = makeRun({ activePhaseLabel: 'phase:test' });

    mirror.applyPhaseLabel(42, 'report', run);

    expect(run.activePhaseLabel).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
    expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  });

  it('logs label failures without throwing or blocking state updates (#469)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const octokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockRejectedValue(new Error('labels unavailable')),
        createLabel: vi.fn().mockResolvedValue({}),
      },
    };
    const mirror = createPhaseLabelMirror(octokit as any, 'acme', 'web');
    const run = makeRun();

    expect(() => mirror.applyPhaseLabel(42, 'implement', run)).not.toThrow();
    expect(run.activePhaseLabel).toBe('phase:implement');
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[phase-labels] apply implement for #42 failed:'),
        expect.any(Error),
      );
    });
    errorSpy.mockRestore();
  });

  it('provisions phase labels and treats existing-label errors as success (#469)', async () => {
    const octokit = {
      issues: {
        removeLabel: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        createLabel: vi
          .fn()
          .mockRejectedValueOnce(Object.assign(new Error('already exists'), { status: 422 }))
          .mockResolvedValue({}),
      },
    };
    const mirror = createPhaseLabelMirror(octokit as any, 'acme', 'web');

    await expect(mirror.provisionLabels()).resolves.toBeUndefined();

    expect(octokit.issues.createLabel).toHaveBeenCalledTimes(8);
    expect(octokit.issues.createLabel).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'web',
      name: 'phase:classify',
      color: expect.any(String),
      description: expect.any(String),
    });
  });
});
