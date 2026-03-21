// src/control-plane/pipeline.ts
import type { Phase, PhaseEvent, RunState } from '../types.js';
import { transition, isTerminal, isComplete, applyGlobalTransition, type TransitionTable } from './fsm.js';
import type { StateManager } from './state.js';
import type { CostTracker } from '../session-runtime/cost.js';
import type { SupabaseRunWriter, PhaseRecord } from '../supabase/run-writer.js';

export type PhaseHandler = (run: RunState) => Promise<PhaseEvent>;

export type PhaseHandlerMap = Partial<Record<Phase, PhaseHandler>>;

export interface PipelineResult {
  outcome: 'complete' | 'stuck' | 'paused' | 'error';
  run: RunState;
  error?: string;
}

export interface PipelineConfig {
  maxAttempts: Record<string, number>;
}

const DEFAULT_MAX_ATTEMPTS: Record<string, number> = {
  implement: 3,
  review: 3,
  test: 3,
  deploy: 2,
};

function buildPhaseRecords(run: RunState): PhaseRecord[] {
  return Object.entries(run.phaseCompletions)
    .filter(([, completed]) => completed)
    .map(([phase]) => ({
      phase,
      outcome: 'success' as const,
      completedAt: new Date().toISOString(),
    }));
}

export async function runPipeline(
  run: RunState,
  table: TransitionTable,
  handlers: PhaseHandlerMap,
  stateMgr: StateManager,
  costTracker: CostTracker,
  config?: Partial<PipelineConfig>,
  runWriter?: SupabaseRunWriter,
): Promise<PipelineResult> {
  const maxAttempts = { ...DEFAULT_MAX_ATTEMPTS, ...config?.maxAttempts };
  const retryCounts: Record<string, number> = {};
  let lastError: string | undefined;

  while (true) {
    // Check for terminal states
    if (isTerminal(run.phase)) {
      const outcome = run.phase === 'stuck' ? 'stuck' : 'paused';
      return outcome === 'stuck' && lastError
        ? { outcome, run, error: lastError }
        : { outcome, run };
    }

    // Check budget before each phase
    const budget = costTracker.checkBudget(run.issueNumber, run.perRunBudget);
    if (!budget.available) {
      // Per-run budget exceeded → stuck (prevents one issue consuming entire daily budget)
      // Daily budget exceeded → paused (resumes on daily reset)
      const isPerRun = budget.reason === 'per-run-budget-exceeded';
      run.phase = isPerRun ? 'stuck' : 'paused';
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: isPerRun ? 'stuck' : 'paused', run };
    }

    // Get the handler for the current phase
    const handler = handlers[run.phase];
    if (!handler) {
      // No handler = auto-success (for phases not yet implemented)
      const event: PhaseEvent = 'success';
      const currentPhase = run.phase;

      // Check for completion before advancing (prevents infinite loop on report)
      if (isComplete(currentPhase, event)) {
        run.phaseCompletions[currentPhase] = true;
        await stateMgr.saveRunState(run);
        void runWriter?.upsertRun(run.id, {
          current_phase: run.phase,
          phases: buildPhaseRecords(run),
        });
        return { outcome: 'complete', run };
      }

      const advanced = advancePhase(run, table, event, maxAttempts, retryCounts);
      if (!advanced) {
        return { outcome: 'error', run, error: `No transition for ${currentPhase}:${event}` };
      }
      // Persist auto-advanced phases (crash recovery)
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      continue;
    }

    // Execute the phase handler
    console.log(`[pipeline] Phase: ${run.phase}`);
    let event: PhaseEvent;
    try {
      event = await handler(run);
    } catch (err) {
      event = 'failure';
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[pipeline] Phase ${run.phase} threw:`, err);
    }

    // Check for global overrides (budget-exceeded, rate-limited)
    const globalNext = applyGlobalTransition(event);
    if (globalNext) {
      run.phase = globalNext;
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      const globalOutcome = globalNext === 'stuck' ? 'stuck' : 'paused';
      return { outcome: globalOutcome, run };
    }

    // Check for completion
    if (isComplete(run.phase, event)) {
      run.phaseCompletions[run.phase] = true;
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: 'complete', run };
    }

    // Advance the FSM
    const currentPhase = run.phase;
    const advanced = advancePhase(run, table, event, maxAttempts, retryCounts);
    if (!advanced) {
      run.phase = 'stuck';
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: 'stuck', run, error: `No transition for ${currentPhase}:${event}` };
    }

    // Save state after each phase transition
    await stateMgr.saveRunState(run);
    void runWriter?.upsertRun(run.id, {
      current_phase: run.phase,
      phases: buildPhaseRecords(run),
    });
  }
}

function advancePhase(
  run: RunState,
  table: TransitionTable,
  event: PhaseEvent,
  maxAttempts: Record<string, number>,
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
    const max = maxAttempts[key] ?? 3;
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
