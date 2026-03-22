// park.ts — Park state management for gated phases
// Governed by: STACK-AC-SPEC-PIPELINE

/**
 * Persisted in RunState when a gate phase returns 'unchanged'.
 * The poll loop re-evaluates parked runs by calling the gate function on each cycle.
 */
export interface ParkState {
  parkedAt: number;         // Date.now() when parked
  gatePhase: string;        // which gate phase (e.g. 'l2-gate')
  deliverable: string;      // spec file path or PR URL
  approvalLabel: string;    // label that unparks forward
  feedbackLabel: string;    // label that triggers re-design
}

/**
 * Gate event recorded in gate history for crash resumption and reporting.
 */
export interface GateEvent {
  gatePhase: string;
  timestamp: string;        // ISO 8601
  outcome: 'approved' | 'feedback';
  feedbackSummary?: string;
}

/**
 * Gate history tracked per run. Stored in RunState.
 */
export interface GateHistory {
  events: GateEvent[];
  iterationCount: number;   // feedback loop counter for the current gate phase
}

/**
 * Creates a ParkState for a gate phase.
 */
export function createParkState(
  gatePhase: string,
  deliverable: string,
  approvalLabel: string,
  feedbackLabel: string,
): ParkState {
  return {
    parkedAt: Date.now(),
    gatePhase,
    deliverable,
    approvalLabel,
    feedbackLabel,
  };
}

/**
 * Checks if a park state has exceeded the timeout duration.
 * Default timeout: 7 days (from L3 spec).
 */
export function isParkExpired(park: ParkState, timeoutMs: number = 7 * 24 * 60 * 60 * 1000): boolean {
  return Date.now() - park.parkedAt > timeoutMs;
}

/**
 * Creates an empty gate history.
 */
export function createGateHistory(): GateHistory {
  return { events: [], iterationCount: 0 };
}

/**
 * Records a gate event and increments the iteration count for feedback outcomes.
 * Trims history to maxEntries (L3 gotcha: cap gate history).
 */
export function recordGateEvent(
  history: GateHistory,
  event: GateEvent,
  maxEntries: number = 6,
): GateHistory {
  const events = [...history.events, event];
  const trimmed = events.length > maxEntries ? events.slice(events.length - maxEntries) : events;
  const iterationCount = event.outcome === 'feedback'
    ? history.iterationCount + 1
    : history.iterationCount;

  return { events: trimmed, iterationCount };
}

/**
 * Checks if the gate iteration count exceeds the maximum allowed.
 * Default: 5 iterations (from L3 spec).
 */
export function isGateIterationExceeded(history: GateHistory, maxIterations: number = 5): boolean {
  return history.iterationCount >= maxIterations;
}

/**
 * Returns the timestamp of the most recent gate event, or undefined if none exist.
 * Used to filter comments "since" the last gate event for feedback extraction.
 */
export function lastGateTimestamp(history: GateHistory): string | undefined {
  if (history.events.length === 0) return undefined;
  const last = history.events[history.events.length - 1];
  return last?.timestamp;
}
