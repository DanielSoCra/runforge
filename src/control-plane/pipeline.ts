// src/control-plane/pipeline.ts
import type { Phase, PhaseEvent, RunState } from '../types.js';
import { transition, isTerminal, isComplete, applyGlobalTransition, type TransitionTable } from './fsm.js';
import type { StateManager } from './state.js';
import type { CostTracker } from '../session-runtime/cost.js';

export type PhaseHandler = (run: RunState) => Promise<PhaseEvent>;

export type PhaseHandlerMap = Partial<Record<Phase, PhaseHandler>>;

export interface PipelineResult {
  outcome: 'complete' | 'stuck' | 'paused' | 'error';
  run: RunState;
  error?: string;
}

export interface PipelineConfig {
  maxRetries: Record<string, number>;
}

const DEFAULT_MAX_RETRIES: Record<string, number> = {
  implement: 3,
  review: 3,
  test: 3,
  deploy: 2,
};

export async function runPipeline(
  run: RunState,
  table: TransitionTable,
  handlers: PhaseHandlerMap,
  stateMgr: StateManager,
  costTracker: CostTracker,
  config?: Partial<PipelineConfig>,
): Promise<PipelineResult> {
  const maxRetries = { ...DEFAULT_MAX_RETRIES, ...config?.maxRetries };
  const retryCounts: Record<string, number> = {};

  while (true) {
    // Check for terminal states
    if (isTerminal(run.phase)) {
      return { outcome: run.phase === 'stuck' ? 'stuck' : 'paused', run };
    }

    // Check budget before each phase
    const budget = costTracker.checkBudget(run.issueNumber);
    if (!budget.available) {
      run.phase = 'paused';
      await stateMgr.saveRunState(run);
      return { outcome: 'paused', run };
    }

    // Get the handler for the current phase
    const handler = handlers[run.phase];
    if (!handler) {
      // No handler = auto-success (for phases not yet implemented)
      const event: PhaseEvent = 'success';
      const currentPhase = run.phase;
      const advanced = advancePhase(run, table, event, maxRetries, retryCounts);
      if (!advanced) {
        return { outcome: 'error', run, error: `No transition for ${currentPhase}:${event}` };
      }
      continue;
    }

    // Execute the phase handler
    let event: PhaseEvent;
    try {
      event = await handler(run);
    } catch {
      event = 'failure';
    }

    // Check for global overrides (budget-exceeded, rate-limited)
    const globalNext = applyGlobalTransition(event);
    if (globalNext) {
      run.phase = globalNext;
      await stateMgr.saveRunState(run);
      return { outcome: 'paused', run };
    }

    // Check for completion
    if (isComplete(run.phase, event)) {
      run.phaseCompletions[run.phase] = true;
      await stateMgr.saveRunState(run);
      return { outcome: 'complete', run };
    }

    // Advance the FSM
    const currentPhase = run.phase;
    const advanced = advancePhase(run, table, event, maxRetries, retryCounts);
    if (!advanced) {
      run.phase = 'stuck';
      await stateMgr.saveRunState(run);
      return { outcome: 'stuck', run, error: `No transition for ${currentPhase}:${event}` };
    }

    // Save state after each phase transition
    await stateMgr.saveRunState(run);
  }
}

function advancePhase(
  run: RunState,
  table: TransitionTable,
  event: PhaseEvent,
  maxRetries: Record<string, number>,
  retryCounts: Record<string, number>,
): boolean {
  const t = transition(table, run.phase, event);
  if (!t) return false;

  const prevPhase = run.phase;
  const nextPhase = t.next;

  // Track retries when a phase loops back to itself on failure
  if (nextPhase === prevPhase && event === 'failure') {
    const key = prevPhase;
    retryCounts[key] = (retryCounts[key] ?? 0) + 1;
    const max = maxRetries[key] ?? 3;
    if (retryCounts[key] >= max) {
      run.phase = 'stuck';
      return true;
    }
  } else if (nextPhase !== prevPhase) {
    // Reset retry count when moving to a new phase
    delete retryCounts[prevPhase];
  }

  // Record phase completion if moving forward on success
  if (nextPhase !== prevPhase && event === 'success') {
    run.phaseCompletions[prevPhase] = true;
  }

  run.phase = nextPhase;
  return true;
}
