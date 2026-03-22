// src/implementation/exit-status.test.ts
import { describe, it, expect } from 'vitest';
import { routeExitStatus, type ExitStatusAction } from './exit-status.js';
import type { ExitStatus } from '../types.js';

describe('routeExitStatus', () => {
  it('returns merge action for completed status', () => {
    const action = routeExitStatus('completed');
    expect(action).toEqual({ type: 'merge' });
  });

  it('returns merge-and-flag action for completed-with-concerns', () => {
    const action = routeExitStatus('completed-with-concerns');
    expect(action).toEqual({ type: 'merge-and-flag' });
  });

  it('returns escalate action for blocked status', () => {
    const action = routeExitStatus('blocked');
    expect(action).toEqual({ type: 'escalate', consumesRetry: false });
  });

  it('returns retry action for needs-context status', () => {
    const action = routeExitStatus('needs-context');
    expect(action).toEqual({ type: 'retry', consumesRetry: true });
  });

  it('returns fail action for failed status', () => {
    const action = routeExitStatus('failed');
    expect(action).toEqual({ type: 'fail' });
  });

  it('returns fail action for timed-out status', () => {
    const action = routeExitStatus('timed-out');
    expect(action).toEqual({ type: 'fail' });
  });

  it('isMergeable returns true only for merge and merge-and-flag', () => {
    const mergeStatuses: ExitStatus[] = ['completed', 'completed-with-concerns'];
    const nonMergeStatuses: ExitStatus[] = ['blocked', 'needs-context', 'failed', 'timed-out'];

    for (const s of mergeStatuses) {
      const action = routeExitStatus(s);
      expect(action.type === 'merge' || action.type === 'merge-and-flag').toBe(true);
    }
    for (const s of nonMergeStatuses) {
      const action = routeExitStatus(s);
      expect(action.type === 'merge' || action.type === 'merge-and-flag').toBe(false);
    }
  });
});
