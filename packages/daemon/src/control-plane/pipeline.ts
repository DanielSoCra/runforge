// src/control-plane/pipeline.ts
import type { FailureRecord, Phase, PhaseEvent, RunState } from '../types.js';
import {
  transition,
  isTerminal,
  isComplete,
  applyGlobalTransition,
  type TransitionTable,
} from './fsm.js';
import { hashError, isCircularError, recordErrorHash } from './error-hash.js';
import type { StateManager } from './state.js';
import type { CostTracker } from '../session-runtime/cost.js';
import type { PhaseRecord, RunWriter } from '../data/run-writer.js';
import type { PhaseLabelMirror } from './phase-labels.js';
import { getBuiltinWorkflow } from './builtin-workflows.js';
import {
  markWorkflowNodeCompleted,
  markWorkflowNodeRunning,
  migrateRunStateToWorkflow,
} from './run-state-migration.js';
import {
  classifyPhaseFailure,
  createFailureRecord,
  recordFailureHistory,
  shouldRetryFailure,
} from './failure-routing.js';

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

/**
 * Halt interlock: if the operator has triggered /halt, park the run at the
 * interrupted phase instead of allowing retry/advance/failure routing. The
 * registry is cleared only after escalation; here we just persist the park
 * shape and exit the loop so the run can resume via resumeParkedRuns.
 */
async function parkOnHalt(
  run: RunState,
  interruptedPhase: Phase,
  stateMgr: StateManager,
  runWriter?: RunWriter,
  phaseLabelMirror?: PhaseLabelMirror,
): Promise<PipelineResult> {
  run.phase = 'paused';
  run.pausedAtPhase = interruptedPhase;
  run.parkedBy = 'halt';
  phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
  await stateMgr.saveRunState(run);
  void runWriter?.upsertRun(run.id, {
    current_phase: 'paused',
    phases: buildPhaseRecords(run),
  });
  return { outcome: 'parked', run };
}

/**
 * Build a diagnostic FailureRecord for a phase that routed to `stuck` via a
 * non-`failure`/non-`containment-breach` event (today: `escalated`).
 *
 * Without this, `escalated → stuck` transitions never produced a failureRecord
 * or `lastError`, so the terminal PipelineResult carried `error: undefined` and
 * the daemon logged the opaque "Unknown error" (#2). We prefer the precise gate
 * finding the handler recorded on `run.lastFailure` (#1b) and fall back to a
 * generic-but-descriptive escalation message when the handler left none.
 */
function buildEscalationFailureRecord(
  run: RunState,
  phase: Phase,
  event: PhaseEvent,
): FailureRecord {
  // #1b: the review handler records the real gate finding on run.lastFailure.
  // Reuse it verbatim so the surfaced error is the actual blocking reason.
  const handlerRecorded = run.lastFailure;
  if (handlerRecorded && handlerRecorded.phase === phase) {
    return handlerRecorded;
  }
  const reason =
    event === 'per-run-budget-exceeded'
      ? `Phase ${phase} hit the per-run budget (cost $${run.cost.toFixed(2)} ≥ budget $${run.perRunBudget.toFixed(2)})`
      : `Phase ${phase} escalated (${event}) — automated repair attempts were exhausted (no handler diagnostic recorded)`;
  return createFailureRecord({
    kind: event === 'per-run-budget-exceeded' ? 'budget-unavailable' : 'human-required',
    phase,
    message: reason,
    severity: 'blocking',
    retryable: false,
    repairAction: 'request-human',
    humanActionRequired: true,
    maxAttempts: 1,
  });
}

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
  runWriter?: RunWriter,
  phaseLabelMirror?: PhaseLabelMirror,
  isHalting?: () => boolean,
): Promise<PipelineResult> {
  const maxAttempts = { ...DEFAULT_MAX_ATTEMPTS, ...config?.maxAttempts };
  const retryCounts: Record<string, number> = {};
  let lastError: string | undefined;
  const workflow = getBuiltinWorkflow(run.variant);
  if (workflow) {
    migrateRunStateToWorkflow(run, workflow);
  }
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
    // Halt interlock: a missing handler pre-flight is still a "save site" that
    // must park, not go stuck, when /halt is active.
    if (isHalting?.() === true) {
      return parkOnHalt(
        run,
        run.phase,
        stateMgr,
        runWriter,
        phaseLabelMirror,
      );
    }
    const msg = `Missing handlers for phases: ${missingHandlers.join(', ')} in variant`;
    console.error(`[pipeline] ${msg}`);
    run.phase = 'stuck';
    phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
    await stateMgr.saveRunState(run);
    void runWriter?.upsertRun(run.id, {
      current_phase: 'stuck',
      phases: buildPhaseRecords(run),
    });
    return { outcome: 'stuck', run, error: msg };
  }

  mirrorCurrentPhase();

  let firstLoop = true;

  while (true) {
    // Check for terminal states
    if (isTerminal(run.phase)) {
      const outcome = run.phase === 'stuck' ? 'stuck' : 'paused';
      return outcome === 'stuck' && lastError !== undefined
        ? { outcome, run, error: lastError }
        : { outcome, run };
    }

    // Halt interlock: after the first iteration, park at the current phase
    // before any handler (re-)executes. This closes the inter-phase window
    // where /halt fires while state is being persisted between phases; the
    // first iteration is intentionally allowed to run once so existing
    // post-handler/budget/missing-handler parks still fire in the right order.
    if (!firstLoop && isHalting?.() === true) {
      return parkOnHalt(
        run,
        run.phase,
        stateMgr,
        runWriter,
        phaseLabelMirror,
      );
    }
    firstLoop = false;

    // Check budget before each phase
    const budget = costTracker.checkBudget(run.issueNumber, run.perRunBudget);
    if (!budget.available) {
      // Halt interlock: budget stop is a pre-handler save site — park if halting.
      if (isHalting?.() === true) {
        return parkOnHalt(
          run,
          run.phase,
          stateMgr,
          runWriter,
          phaseLabelMirror,
        );
      }
      // Per-run budget exceeded → stuck (prevents one issue consuming entire daily budget)
      // Daily budget exceeded → paused (resumes on daily reset)
      const isPerRun = budget.reason === 'per-run-budget-exceeded';
      const phaseBeforeBudgetStop = run.phase;
      run.phase = isPerRun ? 'stuck' : 'paused';
      if (isPerRun) phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      if (isPerRun) {
        // Surface a real reason so the daemon never logs "Unknown error" for a
        // budget-driven stuck (#2 diagnosability — same symptom as escalation).
        lastError = `Per-run budget exhausted before phase "${phaseBeforeBudgetStop}" (cost $${run.cost.toFixed(2)} ≥ budget $${run.perRunBudget.toFixed(2)})`;
        return { outcome: 'stuck', run, error: lastError };
      }
      return { outcome: 'paused', run };
    }

    // Get the handler for the current phase
    const handler = handlers[run.phase];
    if (!handler) {
      // No handler = auto-success (for phases not yet implemented)
      const event: PhaseEvent = 'success';
      const currentPhase = run.phase;
      if (workflow) markWorkflowNodeRunning(run, workflow, currentPhase);

      // Halt interlock: do not auto-advance/save during a halt.
      if (isHalting?.() === true) {
        return parkOnHalt(
          run,
          currentPhase,
          stateMgr,
          runWriter,
          phaseLabelMirror,
        );
      }

      // Check for completion before advancing (prevents infinite loop on report)
      if (isComplete(currentPhase, event)) {
        if (workflow)
          markWorkflowNodeCompleted(run, workflow, currentPhase, event);
        run.phaseCompletions[currentPhase] = true;
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
        await stateMgr.saveRunState(run);
        void runWriter?.upsertRun(run.id, {
          current_phase: run.phase,
          phases: buildPhaseRecords(run),
        });
        return { outcome: 'complete', run };
      }

      const advanced = advancePhase(
        run,
        table,
        event,
        maxAttempts,
        retryCounts,
      );
      if (!advanced) {
        if (workflow)
          markWorkflowNodeCompleted(run, workflow, currentPhase, 'failure');
        return {
          outcome: 'error',
          run,
          error: `No transition for ${currentPhase}:${event}`,
        };
      }
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, currentPhase, event);
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
    const executingPhase = run.phase;
    if (workflow) markWorkflowNodeRunning(run, workflow, executingPhase);
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

    // Halt interlock: park immediately after a handler settles, before any
    // retry / global-failure / advance routing can re-spawn or progress.
    if (isHalting?.() === true) {
      return parkOnHalt(
        run,
        executingPhase,
        stateMgr,
        runWriter,
        phaseLabelMirror,
      );
    }

    // Sync run.cost from costTracker after every phase — costTracker is the
    // single source of truth (updated by runtime.spawnSession for ALL session
    // types: diagnose, implement, review).
    run.cost = costTracker.getRunCost(run.issueNumber);

    const failureRecord =
      event === 'failure' || event === 'containment-breach'
        ? classifyPhaseFailure({
            run,
            phase: executingPhase,
            event,
            message:
              currentError ??
              (run.lastFailure?.phase === executingPhase
                ? run.lastFailure.message
                : undefined),
            maxAttempts: maxAttempts[executingPhase] ?? 3,
          })
        : undefined;

    // Check if handler requested parking (e.g., l2-gate awaiting approval)
    if (run.pausedAtPhase) {
      run.phase = 'paused';
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return { outcome: 'parked', run };
    }

    // Check for global overrides (budget-exceeded, rate-limited, containment-breach)
    const globalNext = applyGlobalTransition(event);
    if (globalNext) {
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, executingPhase, event);
      run.phase = globalNext;
      if (globalNext === 'stuck') {
        // failureRecord is only built for failure/containment-breach. Other
        // global events that route to stuck (per-run-budget-exceeded) must still
        // produce a diagnostic so the result is never empty ("Unknown error").
        const globalStuckRecord =
          failureRecord ??
          buildEscalationFailureRecord(run, executingPhase, event);
        recordFailureHistory(
          run,
          globalStuckRecord,
          globalStuckRecord.humanActionRequired === true
            ? 'human-required'
            : 'terminal-stuck',
        );
        lastError = globalStuckRecord.message;
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      }
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      const globalOutcome = globalNext === 'stuck' ? 'stuck' : 'paused';
      return globalOutcome === 'stuck' && lastError !== undefined
        ? { outcome: globalOutcome, run, error: lastError }
        : { outcome: globalOutcome, run };
    }

    // Check for completion
    if (isComplete(run.phase, event)) {
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, executingPhase, event);
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
    if (event === 'failure' && currentError !== undefined) {
      const errHash = hashError(currentError);
      run.errorHashes = recordErrorHash(errHash, run.errorHashes);
      if (isCircularError(errHash, run.errorHashes)) {
        console.log(
          `[pipeline] Circular error detected in ${run.phase} (hash ${errHash}), transitioning to stuck`,
        );
        if (workflow)
          markWorkflowNodeCompleted(run, workflow, executingPhase, event);
        run.phase = 'stuck';
        if (failureRecord) {
          recordFailureHistory(
            run,
            failureRecord,
            'terminal-stuck',
            'Circular error detected',
          );
        }
        phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
        await stateMgr.saveRunState(run);
        void runWriter?.upsertRun(run.id, {
          current_phase: run.phase,
          phases: buildPhaseRecords(run),
        });
        return {
          outcome: 'stuck',
          run,
          error: `Circular error detected: ${lastError}`,
        };
      }
    }

    if (event === 'failure' && failureRecord) {
      const failureTransition = transition(table, run.phase, event);
      if (
        failureTransition?.next === 'stuck' &&
        shouldRetryFailure(failureRecord)
      ) {
        console.log(
          `[pipeline] Repairable failure in ${run.phase} (${failureRecord.kind}) attempt ${failureRecord.attempt}/${failureRecord.maxAttempts}; retrying phase`,
        );
        if (workflow)
          markWorkflowNodeCompleted(run, workflow, executingPhase, event);
        recordFailureHistory(run, failureRecord, 'retrying');
        await stateMgr.saveRunState(run);
        void runWriter?.upsertRun(run.id, {
          current_phase: run.phase,
          phases: buildPhaseRecords(run),
        });
        continue;
      }
    }

    // Advance the FSM
    const currentPhase = run.phase;
    const advanced = advancePhase(run, table, event, maxAttempts, retryCounts);
    if (!advanced) {
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, executingPhase, 'failure');
      run.phase = 'stuck';
      if (failureRecord) {
        recordFailureHistory(
          run,
          failureRecord,
          'terminal-stuck',
          `No transition for ${currentPhase}:${event}`,
        );
      }
      phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
      await stateMgr.saveRunState(run);
      void runWriter?.upsertRun(run.id, {
        current_phase: run.phase,
        phases: buildPhaseRecords(run),
      });
      return {
        outcome: 'stuck',
        run,
        error: `No transition for ${currentPhase}:${event}`,
      };
    }

    // Save state after each phase transition
    if (run.phase === 'stuck') {
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, executingPhase, event);
      // `failureRecord` is only built for failure/containment-breach events.
      // Other events that route to stuck (today: `escalated`) must still
      // produce a diagnostic record + lastError so the terminal result is never
      // empty — otherwise the daemon logs "Unknown error" (#2).
      const stuckRecord =
        failureRecord ??
        buildEscalationFailureRecord(run, executingPhase, event);
      recordFailureHistory(
        run,
        stuckRecord,
        stuckRecord.humanActionRequired === true ? 'human-required' : 'terminal-stuck',
      );
      lastError = stuckRecord.message;
      phaseLabelMirror?.clearPhaseLabels(run.issueNumber, run);
    } else {
      if (workflow)
        markWorkflowNodeCompleted(run, workflow, executingPhase, event);
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
