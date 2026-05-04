// src/control-plane/pipeline.ts
import type { Phase, PhaseEvent, RunState } from '../types.js';
import { transition, isTerminal, isComplete, applyGlobalTransition, type TransitionTable } from './fsm.js';
import { hashError, isCircularError, recordErrorHash } from './error-hash.js';
import type { StateManager } from './state.js';
import type { CostTracker } from '../session-runtime/cost.js';
import type { SupabaseRunWriter, PhaseRecord } from '../supabase/run-writer.js';
import type { PhaseLabelMirror } from './phase-labels.js';

export type PhaseHandler = (run: RunState) => Promise<PhaseEvent>;

export type PhaseHandlerMap = Partial<Record<Phase, PhaseHandler>>;

export interface PipelineResult {
  outcome: 'complete' | 'stuck' | 'paused' | 'error' | 'parked';
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
  phaseLabelMirror?: PhaseLabelMirror,
): Promise<PipelineResult> {
  const maxAttempts = { ...DEFAULT_MAX_ATTEMPTS, ...config?.maxAttempts };
  const retryCounts: Record<string, number> = {};
  let lastError: string | undefined;
  const mirrorCurrentPhase = () => {
    if (!phaseLabelMirror) return;
    if (run.phase === 'report') {
      phaseLabelMirror.clearPhaseLabels(run.issueNumber, run);
      return;
    }
    phaseLabelMirror.applyPhaseLabel(run.issueNumber, run.phase, run);
  };

  // Pre-flight: validate all non-terminal phases have handlers
  const missingHandlers: string[] = [];
  for (const phase of Object.keys(table)) {
    if (phase === 'stuck' || phase === 'paused') continue;
    if (!handlers[phase as Phase]) {
      missingHandlers.push(phase);
    }
  }
  if (missingHandlers.length > 0) {
    const msg = `Missing handlers for phases: ${missingHandlers.join(', ')} in variant`;
    console.error(`[pipeline] ${msg}`);
    run.phase = 'stuck';
    phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
    await stateMgr.saveRunState(run);
    void runWriter?.upsertRun(run.id, { current_phase: 'stuck', phases: buildPhaseRecords(run) });
    return { outcome: 'stuck', run, error: msg };
  }

  mirrorCurrentPhase();

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
      if (isPerRun) phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
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
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
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
      if (run.phase === 'stuck') {
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      } else {
        mirrorCurrentPhase();
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
    let currentError: string | undefined;
    try {
      event = await handler(run);
    } catch (err) {
      event = 'failure';
      currentError = err instanceof Error ? err.message : String(err);
      lastError = currentError;
      console.error(`[pipeline] Phase ${run.phase} threw:`, err);
    }

    // Sync run.cost from costTracker after every phase — costTracker is the
    // single source of truth (updated by runtime.spawnSession for ALL session
    // types: diagnose, implement, review).
    run.cost = costTracker.getRunCost(run.issueNumber);

    // Check if handler requested parking (e.g., l2-gate awaiting approval)
    if (run.pausedAtPhase) {
      run.phase = 'paused';
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, { current_phase: run.phase, phases: buildPhaseRecords(run) });
      return { outcome: 'parked', run };
    }

    // Check for global overrides (budget-exceeded, rate-limited, containment-breach)
    const globalNext = applyGlobalTransition(event);
    if (globalNext) {
      run.phase = globalNext;
      if (globalNext === 'stuck') phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
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
      phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: 'complete', run };
    }

    // Circular fix detection: hash the error and check for repeated failures.
    // Runs before advancePhase so circular detection takes precedence over retry exhaustion.
    // Only applies to thrown exceptions (currentError set); returned 'failure' events have no error to hash.
    if (event === 'failure' && currentError) {
      const errHash = hashError(currentError);
      run.errorHashes = recordErrorHash(errHash, run.errorHashes);
      if (isCircularError(errHash, run.errorHashes)) {
        console.log(`[pipeline] Circular error detected in ${run.phase} (hash ${errHash}), transitioning to stuck`);
        run.phase = 'stuck';
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
        await stateMgr.saveRunState(run);
        void runWriter?.upsertRun(run.id, {
          current_phase: run.phase,
          phases: buildPhaseRecords(run),
        });
        return { outcome: 'stuck', run, error: `Circular error detected: ${lastError}` };
      }
    }

    // Advance the FSM
    const currentPhase = run.phase;
    const advanced = advancePhase(run, table, event, maxAttempts, retryCounts);
    if (!advanced) {
      run.phase = 'stuck';
      phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: 'stuck', run, error: `No transition for ${currentPhase}:${event}` };
    }

    // Save state after each phase transition
    if (run.phase === 'stuck') {
      phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
    } else {
      mirrorCurrentPhase();
    }
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
