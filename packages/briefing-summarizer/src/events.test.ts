import { describe, it, expect } from 'vitest';
import { extractActivityEvents, type PreviousSnapshot } from './events.js';
import type { SignalResult } from './signals.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseSignals: SignalResult = {
  runs: [
    {
      id: 'run-1',
      issue_number: 42,
      outcome: 'success',
      phase: 'done',
      updated_at: '2026-03-22T10:00:00Z',
      issue_url: 'https://github.com/org/repo/issues/42',
    },
    {
      id: 'run-2',
      issue_number: 99,
      outcome: 'stuck',
      phase: 'implementation',
      updated_at: '2026-03-22T10:05:00Z',
      issue_url: 'https://github.com/org/repo/issues/99',
    },
  ],
  daemonStatus: { state: 'running' },
  gitLog: [
    'abc1234 Merge pull request #50 from org/feature-branch',
    'def5678 feat: add dashboard widget',
  ],
  heartbeatAt: '2026-03-22T10:10:00Z',
  gaps: [],
};

const previousSnapshot: PreviousSnapshot = {
  runs: [
    {
      id: 'run-1',
      issue_number: 42,
      outcome: 'in-progress',
      phase: 'implementation',
      updated_at: '2026-03-22T09:00:00Z',
    },
    {
      id: 'run-2',
      issue_number: 99,
      outcome: 'in-progress',
      phase: 'implementation',
      updated_at: '2026-03-22T09:00:00Z',
    },
  ],
  gitLog: ['ghi9012 chore: update deps'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractActivityEvents', () => {
  describe('run state transitions', () => {
    it('detects outcome changes from previous snapshot', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot);

      const outcomeEvents = events.filter(
        (e) => e.summary.includes('outcome changed'),
      );
      expect(outcomeEvents.length).toBeGreaterThanOrEqual(2);

      // run-1: in-progress -> success
      const run1Event = outcomeEvents.find((e) => e.summary.includes('run-1'));
      expect(run1Event).toBeDefined();
      expect(run1Event!.summary).toContain('in-progress');
      expect(run1Event!.summary).toContain('success');
      expect(run1Event!.event_type).toBe('completion');
      expect(run1Event!.severity).toBe('info');

      // run-2: in-progress -> stuck
      const run2Event = outcomeEvents.find((e) => e.summary.includes('run-2'));
      expect(run2Event).toBeDefined();
      expect(run2Event!.summary).toContain('stuck');
      expect(run2Event!.severity).toBe('error');
    });

    it('detects phase changes from previous snapshot', () => {
      const signals: SignalResult = {
        ...baseSignals,
        runs: [
          {
            id: 'run-1',
            issue_number: 42,
            outcome: 'in-progress',
            phase: 'validation',
            updated_at: '2026-03-22T10:00:00Z',
          },
        ],
      };

      const prev: PreviousSnapshot = {
        runs: [
          {
            id: 'run-1',
            issue_number: 42,
            outcome: 'in-progress',
            phase: 'implementation',
            updated_at: '2026-03-22T09:00:00Z',
          },
        ],
      };

      const events = extractActivityEvents(signals, prev);

      const phaseEvent = events.find(
        (e) => e.event_type === 'state-transition' && e.summary.includes('phase changed'),
      );
      expect(phaseEvent).toBeDefined();
      expect(phaseEvent!.summary).toContain('implementation');
      expect(phaseEvent!.summary).toContain('validation');
    });

    it('detects new runs not in previous snapshot', () => {
      const signals: SignalResult = {
        ...baseSignals,
        runs: [
          { id: 'run-new', issue_number: 200, outcome: 'in-progress', updated_at: '2026-03-22T10:00:00Z' },
        ],
      };

      const events = extractActivityEvents(signals, previousSnapshot);

      const newRunEvent = events.find((e) => e.summary.includes('run-new'));
      expect(newRunEvent).toBeDefined();
      expect(newRunEvent!.summary).toContain('started');
      expect(newRunEvent!.event_type).toBe('state-transition');
    });
  });

  describe('merge detection', () => {
    it('detects merge commits not in previous git log', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot);

      const mergeEvents = events.filter((e) => e.event_type === 'merge');
      expect(mergeEvents).toHaveLength(1);
      expect(mergeEvents[0].summary).toContain('Merge pull request #50');
      expect(mergeEvents[0].links).toContainEqual(
        expect.objectContaining({ label: 'PR #50' }),
      );
    });

    it('builds full GitHub PR URL when repoUrl is provided (#228)', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot, 'https://github.com/acme/web');

      const mergeEvents = events.filter((e) => e.event_type === 'merge');
      expect(mergeEvents).toHaveLength(1);
      expect(mergeEvents[0].links[0].url).toBe('https://github.com/acme/web/pull/50');
    });

    it('falls back to fragment URL when repoUrl is null (#228)', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot, null);

      const mergeEvents = events.filter((e) => e.event_type === 'merge');
      expect(mergeEvents).toHaveLength(1);
      expect(mergeEvents[0].links[0].url).toBe('#50');
    });

    it('does not flag non-merge commits as merges', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot);

      const mergeEvents = events.filter((e) => e.event_type === 'merge');
      const hasFeatCommit = mergeEvents.some((e) =>
        e.summary.includes('add dashboard widget'),
      );
      expect(hasFeatCommit).toBe(false);
    });

    it('skips merge commits already in previous snapshot', () => {
      const prev: PreviousSnapshot = {
        ...previousSnapshot,
        gitLog: [
          'abc1234 Merge pull request #50 from org/feature-branch',
          'ghi9012 chore: update deps',
        ],
      };

      const events = extractActivityEvents(baseSignals, prev);

      const mergeEvents = events.filter((e) => e.event_type === 'merge');
      expect(mergeEvents).toHaveLength(0);
    });
  });

  describe('error detection from stuck runs', () => {
    it('detects stuck runs as errors', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot);

      const errorEvents = events.filter((e) => e.event_type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      const stuckEvent = errorEvents.find((e) => e.summary.includes('run-2'));
      expect(stuckEvent).toBeDefined();
      expect(stuckEvent!.severity).toBe('error');
      expect(stuckEvent!.summary).toContain('stuck');
    });

    it('does not flag non-stuck runs as errors', () => {
      const signals: SignalResult = {
        ...baseSignals,
        runs: [
          { id: 'run-1', issue_number: 42, outcome: 'success', updated_at: '2026-03-22T10:00:00Z' },
        ],
      };

      const events = extractActivityEvents(signals, null);

      const errorEvents = events.filter((e) => e.event_type === 'error');
      expect(errorEvents).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty array when no previous snapshot and no notable signals', () => {
      const signals: SignalResult = {
        runs: [],
        daemonStatus: { state: 'idle' },
        gitLog: [],
        heartbeatAt: '2026-03-22T10:10:00Z',
        gaps: [],
      };

      const events = extractActivityEvents(signals, null);
      expect(events).toHaveLength(0);
    });

    it('includes links from run data', () => {
      const events = extractActivityEvents(baseSignals, previousSnapshot);

      const run1Events = events.filter((e) => e.summary.includes('run-1'));
      const withLinks = run1Events.find((e) => e.links.length > 0);
      expect(withLinks).toBeDefined();
      expect(withLinks!.links).toContainEqual(
        expect.objectContaining({ url: 'https://github.com/org/repo/issues/42' }),
      );
    });
  });
});
