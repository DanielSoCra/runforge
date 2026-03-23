// src/validation/proactive-scheduler.ts
import type { ProactiveFinding } from './proactive-reviewer.js';

export interface ProactiveState {
  lastReviewedAt: Record<string, string>;
  cycleIndex: number;
}

export interface FormattedFinding {
  title: string;
  severity: string;
  location: string;
  description: string;
  evidence: string;
}

/**
 * Stateless utilities for proactive review scheduling. State persistence
 * (reading/writing state/proactive-review.json) is the caller's responsibility.
 */
export class ProactiveScheduler {
  /**
   * Pick the codebase area with the oldest lastReviewedAt timestamp.
   * Areas with no timestamp are treated as epoch 0 (highest staleness priority).
   */
  static pickNextArea(state: ProactiveState, areas: string[]): string | undefined {
    if (areas.length === 0) return undefined;
    return areas.reduce((oldest, area) => {
      const oldestTs = state.lastReviewedAt[oldest] ?? '';
      const areaTs = state.lastReviewedAt[area] ?? '';
      return areaTs < oldestTs ? area : oldest;
    });
  }

  /**
   * Check whether proactive review should be deferred due to resource pressure.
   * Returns true if activeWorkers >= maxAgents * throttleThreshold.
   */
  static shouldThrottle(
    activeWorkers: number,
    maxAgents: number,
    throttleThreshold: number,
  ): boolean {
    return activeWorkers >= maxAgents * throttleThreshold;
  }

  /**
   * Return a new state with the reviewed area's timestamp updated and cycleIndex incremented.
   */
  static updateState(state: ProactiveState, area: string): ProactiveState {
    return {
      lastReviewedAt: {
        ...state.lastReviewedAt,
        [area]: new Date().toISOString(),
      },
      cycleIndex: state.cycleIndex + 1,
    };
  }

  /**
   * Format a proactive finding as a structured GitHub issue body.
   */
  static formatFindingBody(finding: FormattedFinding): string {
    return [
      `**Severity:** ${finding.severity}`,
      `**Location:** ${finding.location}`,
      '',
      finding.description,
      '',
      `**Evidence:** ${finding.evidence}`,
    ].join('\n');
  }

  /**
   * Create a fresh empty state for first-time initialization.
   */
  static emptyState(): ProactiveState {
    return { lastReviewedAt: {}, cycleIndex: 0 };
  }
}
