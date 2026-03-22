// src/implementation/exit-status.ts
import type { ExitStatus } from '../types.js';

export type ExitStatusAction =
  | { type: 'merge' }
  | { type: 'merge-and-flag' }
  | { type: 'escalate'; consumesRetry: false }
  | { type: 'retry'; consumesRetry: true }
  | { type: 'fail' };

/**
 * Route an exit status to the appropriate follow-up action.
 * Per L3 spec: discriminated union switch on exit status.
 */
export function routeExitStatus(status: ExitStatus): ExitStatusAction {
  switch (status) {
    case 'completed':
      return { type: 'merge' };
    case 'completed-with-concerns':
      return { type: 'merge-and-flag' };
    case 'blocked':
      return { type: 'escalate', consumesRetry: false as const };
    case 'needs-context':
      return { type: 'retry', consumesRetry: true as const };
    case 'failed':
    case 'timed-out':
      return { type: 'fail' };
  }
}

export function isMergeable(status: ExitStatus): boolean {
  const action = routeExitStatus(status);
  return action.type === 'merge' || action.type === 'merge-and-flag';
}
