// dispatch.ts — Main pipeline dispatch orchestration
// Governed by: STACK-AC-PIPELINE-DISPATCH

import type { SessionRuntime } from '../session-runtime/runtime.js';
import type { SessionContext, ExitStatus } from '../types.js';
import type { DispatchRequest, DispatchResult } from './session-types.js';
import { mapWorkTypeToSessionType, getPipelineAgentDef } from './session-types.js';
import { isConnectionError, directInvoke } from './fallback.js';
import { SessionError } from '../session-runtime/session-error.js';

/**
 * Dispatch state tracked by the orchestration script between cycles.
 */
export interface PipelineRunState {
  failCount: number;
  sleepUntil: number; // epoch ms — 0 means no sleep
}

/**
 * Dispatches a pipeline session through the Session Runtime with fallback to direct CLI.
 *
 * The Session Runtime provides cost tracking, rate limiting, and containment.
 * When unreachable (ECONNREFUSED/ENOTFOUND/ETIMEDOUT), falls back to direct
 * invocation with degraded containment (temporary — removed in Phase 2).
 */
export async function dispatchWithFallback(
  req: DispatchRequest,
  runtime: SessionRuntime,
): Promise<DispatchResult> {
  const sessionType = mapWorkTypeToSessionType(req.sessionType);
  const agentDef = getPipelineAgentDef(sessionType);
  const startMs = Date.now();

  const context: SessionContext = {
    variables: {
      issueNumber: String(req.context.issueNumber),
      repo: req.context.repo,
      ...(req.context.feedback ? { feedback: req.context.feedback } : {}),
    },
    baseBranch: req.baseBranch,
  };

  try {
    const result = await runtime.spawnSession(
      // SessionRuntime expects its SessionType union; pipeline types extend this.
      // Pass agentDef override so the runtime uses our pipeline definition.
      sessionType as Parameters<SessionRuntime['spawnSession']>[0],
      context,
      req.context.issueNumber,
      { agentDef },
    );

    const durationMs = Date.now() - startMs;

    if (result.ok) {
      return {
        status: mapExitStatus(result.value.exitStatus),
        costIncurred: result.value.cost,
        durationMs,
        summary: result.value.output.slice(0, 500),
      };
    }

    // Session Runtime returned an error — map it to a DispatchResult
    return mapSessionError(result.error, durationMs);
  } catch (error) {
    // Connection error — fall back to direct CLI invocation
    if (isConnectionError(error)) {
      return directInvoke(req);
    }
    // Unexpected error — return as failure
    const durationMs = Date.now() - startMs;
    return {
      status: 'failed',
      costIncurred: 0,
      durationMs,
      summary: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    };
  }
}

/**
 * Handles a DispatchResult by updating the run state.
 * Exhaustive pattern match on status — no default case.
 * TypeScript's `never` check catches missing variants at compile time.
 */
export function handleResult(result: DispatchResult, state: PipelineRunState): void {
  switch (result.status) {
    case 'completed':
      state.failCount = 0;
      break;
    case 'failed':
    case 'timed-out':
      state.failCount++;
      break;
    case 'budget-exceeded':
      state.sleepUntil = nextBudgetReset();
      break;
    case 'rate-limited':
      state.sleepUntil = Date.now() + (result.cooldownMs ?? 60_000);
      break;
    default: {
      const _exhaustive: never = result.status;
      throw new Error(`Unhandled dispatch status: ${_exhaustive}`);
    }
  }
}

/**
 * Checks whether the pipeline should sleep before the next dispatch cycle.
 * Returns 0 if no sleep is needed, otherwise the number of milliseconds to wait.
 */
export function computeBackoffMs(state: PipelineRunState): number {
  // Sleep-until takes priority (budget-exceeded or rate-limited)
  const now = Date.now();
  if (state.sleepUntil > now) {
    return state.sleepUntil - now;
  }
  state.sleepUntil = 0;

  // Exponential backoff on failures: 60s, 120s, 240s, ... capped at 3600s
  if (state.failCount > 0) {
    const backoff = Math.min(60_000 * Math.pow(2, state.failCount - 1), 3_600_000);
    return backoff;
  }

  return 0;
}

// --- Internal helpers ---

function mapExitStatus(exitStatus: ExitStatus): DispatchResult['status'] {
  switch (exitStatus) {
    case 'completed':
    case 'completed-with-concerns':
      return 'completed';
    case 'timed-out':
      return 'timed-out';
    case 'blocked':
    case 'needs-context':
    case 'failed':
      return 'failed';
    default: {
      const _exhaustive: never = exitStatus;
      throw new Error(`Unhandled exit status: ${_exhaustive}`);
    }
  }
}

function mapSessionError(error: Error, durationMs: number): DispatchResult {
  if (error instanceof SessionError) {
    // Budget exceeded — detected via message prefix from SessionError.budgetExceeded()
    if (error.message.startsWith('Budget exceeded')) {
      return {
        status: 'budget-exceeded',
        costIncurred: error.cost,
        durationMs,
        summary: error.message,
      };
    }
    if (error.rateLimited) {
      // Extract cooldown from the rate limiter's message if available
      const cooldownMatch = error.message.match(/cooling down for (\d+)s/);
      const cooldownMs = cooldownMatch?.[1] ? parseInt(cooldownMatch[1], 10) * 1000 : undefined;
      return {
        status: 'rate-limited',
        costIncurred: error.cost,
        durationMs,
        summary: error.message,
        cooldownMs,
      };
    }
    if (error.containmentBreach) {
      return {
        status: 'failed',
        costIncurred: error.cost,
        durationMs,
        summary: `Containment breach: ${error.message}`,
      };
    }
  }

  return {
    status: 'failed',
    costIncurred: 0,
    durationMs,
    summary: error.message.slice(0, 500),
  };
}

function nextBudgetReset(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}
