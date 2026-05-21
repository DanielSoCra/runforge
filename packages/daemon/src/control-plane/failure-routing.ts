import type {
  FailureRecord,
  FailureSeverity,
  Phase,
  PhaseEvent,
  PipelineFailureKind,
  RepairAction,
  RepairHistoryOutcome,
  RunState,
} from '../types.js';
import { hashError } from './error-hash.js';

const DEFAULT_REPAIR_ATTEMPTS = 3;

interface FailureReportInput {
  kind: PipelineFailureKind;
  phase: Phase;
  message: string;
  severity: FailureSeverity;
  retryable: boolean;
  repairAction: RepairAction;
  maxAttempts?: number;
  relatedArtifactRef?: string;
  humanActionRequired?: boolean;
}

interface ClassifyFailureInput {
  run: RunState;
  phase: Phase;
  event: PhaseEvent;
  message?: string;
  maxAttempts?: number;
}

export function createFailureRecord(input: FailureReportInput): FailureRecord {
  const now = new Date().toISOString();
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_REPAIR_ATTEMPTS);
  return {
    kind: input.kind,
    phase: input.phase,
    message: input.message,
    normalizedErrorHash: hashFailure(input.kind, input.message),
    severity: input.severity,
    retryable: input.retryable,
    repairAction: input.repairAction,
    attempt: 0,
    maxAttempts,
    firstSeenAt: now,
    lastSeenAt: now,
    relatedArtifactRef: input.relatedArtifactRef,
    humanActionRequired: input.humanActionRequired,
  };
}

export function classifyPhaseFailure(input: ClassifyFailureInput): FailureRecord {
  const reported = currentReportedFailure(input.run, input.phase);
  const base = reported ?? fallbackFailure(input.phase, input.event, input.message);
  const configuredMaxAttempts = base.retryable
    ? input.maxAttempts ?? base.maxAttempts
    : base.maxAttempts;
  const maxAttempts = Math.max(
    1,
    configuredMaxAttempts ?? DEFAULT_REPAIR_ATTEMPTS,
  );
  const hash = hashFailure(base.kind, input.message ?? base.message);
  const now = new Date().toISOString();
  const attempt =
    countPriorAttempts(input.run, input.phase, base.kind, hash) + 1;

  return {
    ...base,
    message: input.message ?? base.message,
    normalizedErrorHash: hash,
    attempt,
    maxAttempts,
    firstSeenAt: base.firstSeenAt,
    lastSeenAt: now,
  };
}

export function shouldRetryFailure(failure: FailureRecord): boolean {
  return (
    failure.retryable &&
    !failure.humanActionRequired &&
    failure.repairAction !== 'none' &&
    failure.repairAction !== 'request-human' &&
    failure.attempt < failure.maxAttempts
  );
}

export function recordFailureHistory(
  run: RunState,
  failure: FailureRecord,
  outcome: RepairHistoryOutcome,
  message?: string,
): void {
  run.lastFailure = failure;
  run.repairHistory = [
    ...(run.repairHistory ?? []),
    {
      at: new Date().toISOString(),
      failure,
      outcome,
      message,
    },
  ];
}

function currentReportedFailure(
  run: RunState,
  phase: Phase,
): FailureRecord | undefined {
  const failure = run.lastFailure;
  if (!failure) return undefined;
  if (failure.phase !== phase) return undefined;
  return failure.attempt === 0 ? failure : undefined;
}

function fallbackFailure(
  phase: Phase,
  event: PhaseEvent,
  message?: string,
): FailureRecord {
  if (event === 'containment-breach') {
    return createFailureRecord({
      kind: 'containment-violation',
      phase,
      message: message ?? 'Confirmed containment violation',
      severity: 'critical',
      retryable: false,
      repairAction: 'request-human',
      humanActionRequired: true,
      maxAttempts: 1,
    });
  }

  return createFailureRecord({
    kind: 'human-required',
    phase,
    message: message ?? `Phase ${phase} reported ${event}`,
    severity: 'blocking',
    retryable: false,
    repairAction: 'request-human',
    humanActionRequired: true,
    maxAttempts: 1,
  });
}

function countPriorAttempts(
  run: RunState,
  phase: Phase,
  kind: PipelineFailureKind,
  normalizedErrorHash: string,
): number {
  return (run.repairHistory ?? []).filter(
    (entry) =>
      entry.failure.phase === phase &&
      entry.failure.kind === kind &&
      entry.failure.normalizedErrorHash === normalizedErrorHash,
  ).length;
}

function hashFailure(kind: PipelineFailureKind, message: string): string {
  return hashError(`${kind}:${message}`);
}
