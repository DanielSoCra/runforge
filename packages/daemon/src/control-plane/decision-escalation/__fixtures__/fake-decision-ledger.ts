/**
 * fake-decision-ledger — the CI-default (no-Postgres) lifecycle fake for the
 * decision-escalation approval surface (first-use PR1, A2 / T1.4).
 *
 * WHY a fake instead of a PGlite-backed real writer: the real `IndexWriter`'s
 * single-writer + read-only-session guarantees "cannot be modelled by an
 * in-process backend" (see `pg-test-harness.ts`). So we seam at the *ledger
 * contract* level — the exact methods the daemon's boot / resume / tick call
 * sites touch — and drive a small, deterministic state machine that enforces the
 * §6.2 lifecycle invariants the joined round-trip depends on:
 *
 *   raise        -> 'raised'
 *   notify       -> 'notified'        (only from 'raised'; else a status no-op)
 *   answer       -> 'answered'        (off-menu choice REJECTED; answer-once:
 *                                       identical re-answer = no-op, conflicting
 *                                       = reject, terminal/'resumed' = unchanged)
 *   advanceToResumed -> 'resumed'
 *
 * The two seam interfaces are derived from the ACTUAL call sites (daemon boot
 * `~336-420`, `resumeParkedRuns`/`resumeIntegrateParkedRun`, the integrate park
 * publish in `phases.ts`, `bootReconcile`/`markOverdue`/`supersedeIfMoot` in
 * `reconcile.ts`). The `_AssertSeam*` checks below make each seam a faithful
 * SUBSET of the real `DecisionIndexManager` / `DecisionLedger` surfaces — listing
 * a method (or signature) the real class lacks fails compilation, which is the
 * forcing function. A method the *daemon* needs but the seam omits surfaces at
 * runtime as "<m> is not a function" in the joined test (the other half of the
 * forcing function).
 */
import type {
  ReadModel,
  ProtectedStore,
  DecisionView,
} from '@auto-claude/decision-index';
import type { ResumeMode } from '@auto-claude/decision-protocol';
import type { DecisionLedger, NotifyResult, AnswerResult } from '../ledger.js';
import type { DecisionIndexManager, RuntimeDegradable } from '../manager.js';

/** The ledger surface the daemon's approval-path call sites touch. */
export interface DecisionLedgerLike {
  raise(rawRequest: unknown): Promise<{
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  }>;
  notify(decisionId: string): Promise<NotifyResult>;
  answer(
    decisionId: string,
    chosenOption: string,
    answerer: string,
    now?: string,
  ): Promise<AnswerResult>;
  statusOf(decisionId: string): Promise<string | undefined>;
  advanceToResumed(decisionId: string, mode?: ResumeMode): Promise<void>;
  reconcile(): Promise<unknown>;
  supersede(
    decisionId: string,
    supersededBy?: string,
    now?: string,
  ): Promise<boolean>;
  expireOverdue(now: Date): Promise<string[]>;
  revealProtected(
    decisionId: string,
    ref: string,
    actor: string,
  ): Promise<{ field: string; value: string }>;
  protectedStore(): ProtectedStore;
  readonly reader: ReadModel;
}

/** The manager surface the daemon's boot / resume / tick call sites touch. */
export interface DecisionManagerLike extends RuntimeDegradable {
  init(): Promise<void>;
  isEnabled(): boolean;
  isAvailable(): boolean;
  ledger(): DecisionLedgerLike;
  protectedStore(): ProtectedStore;
  revealProtected(
    decisionId: string,
    ref: string,
    actor: string,
  ): Promise<{ field: string; value: string }>;
  close(): Promise<void>;
  isRuntimeDegraded(): boolean;
}

// Compile-time forcing function: the real classes MUST satisfy the seam, so the
// seam can only name methods (with compatible signatures) the real surface has.
type _AssertManagerSeam =
  DecisionIndexManager extends DecisionManagerLike ? true : never;
type _AssertLedgerSeam =
  DecisionLedger extends DecisionLedgerLike ? true : never;
const _assertManagerSeam: _AssertManagerSeam = true;
const _assertLedgerSeam: _AssertLedgerSeam = true;
void _assertManagerSeam;
void _assertLedgerSeam;

/** Simplified lifecycle vocabulary (a faithful projection of the §6.2 states). */
export type FakeStatus = 'raised' | 'notified' | 'answered' | 'resumed';

interface FakeRow {
  decisionId: string;
  status: FakeStatus;
  options: string[];
  answeredOption?: string;
}

/** Thrown when an answer choice is not among the offered options (off-menu). */
export class FakeOffMenuError extends Error {
  constructor(decisionId: string, choice: string, options: string[]) {
    super(
      `off-menu answer "${choice}" for ${decisionId} (offered: ${options.join(', ')})`,
    );
    this.name = 'FakeOffMenuError';
  }
}

/** Thrown when a conflicting second answer is submitted (answer-once). */
export class FakeAnsweredOnceConflictError extends Error {
  constructor(decisionId: string, prior: string, next: string) {
    super(
      `answer-once conflict for ${decisionId}: already answered "${prior}", got "${next}"`,
    );
    this.name = 'FakeAnsweredOnceConflictError';
  }
}

const TERMINAL: ReadonlySet<FakeStatus> = new Set<FakeStatus>(['resumed']);

function extractOptionIds(rawRequest: unknown): string[] {
  if (typeof rawRequest !== 'object' || rawRequest === null) return [];
  const opts = (rawRequest as { options?: unknown }).options;
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) =>
      typeof o === 'object' && o !== null
        ? (o as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string');
}

function extractDecisionId(rawRequest: unknown): string {
  if (typeof rawRequest !== 'object' || rawRequest === null) {
    throw new Error('fake ledger: raise() requires an object request');
  }
  const id = (rawRequest as { decision_id?: unknown }).decision_id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('fake ledger: raise() requires a string decision_id');
  }
  return id;
}

/**
 * A minimal read-model / protected-store the daemon does not exercise in the
 * CI-default round-trip (the resume path never reads them), but the seam requires
 * for faithfulness. They throw if ever touched so a silent wrong-path is loud.
 */
function unusedReader(): ReadModel {
  const throwUnused = (): never => {
    throw new Error('fake ledger: reader is not implemented (not exercised)');
  };
  return {
    get: throwUnused,
    list: throwUnused,
    listRanked: throwUnused,
    detail: throwUnused,
  } as unknown as ReadModel;
}

function unusedProtectedStore(): ProtectedStore {
  const throwUnused = (): never => {
    throw new Error(
      'fake ledger: protectedStore is not implemented (not exercised)',
    );
  };
  return {
    put: throwUnused,
    get: throwUnused,
    findRefForField: throwUnused,
    responseHmac: throwUnused,
    verifyIntegrity: throwUnused,
  } as unknown as ProtectedStore;
}

/**
 * The lifecycle fake. Construct, optionally seed a notified row (mirrors the
 * real-PG `seedNotifiedIntegrate`), then drive raise/notify/answer/advance.
 */
export class FakeDecisionLedger implements DecisionLedgerLike {
  readonly rows = new Map<string, FakeRow>();
  readonly reader: ReadModel = unusedReader();

  /** Seed a row directly into `notified` (the only status `answer()` proceeds from). */
  seedNotified(decisionId: string, options: string[]): void {
    this.rows.set(decisionId, { decisionId, status: 'notified', options });
  }

  /**
   * Seed a row directly into terminal `resumed` (for tests that need an
   * already-consumed decision). Use this INSTEAD of smuggling a notified row
   * through advanceToResumed — the real ledger only reaches `resumed` from the
   * post-answer state, and the fake now mirrors that (see advanceToResumed).
   */
  seedResumed(decisionId: string, options: string[]): void {
    this.rows.set(decisionId, { decisionId, status: 'resumed', options });
  }

  async raise(rawRequest: unknown): Promise<{
    decision_id: string;
    outcome: 'admitted' | 'unchanged' | 'superseded';
  }> {
    const decisionId = extractDecisionId(rawRequest);
    const options = extractOptionIds(rawRequest);
    const existing = this.rows.get(decisionId);
    if (existing) {
      return { decision_id: decisionId, outcome: 'unchanged' };
    }
    this.rows.set(decisionId, { decisionId, status: 'raised', options });
    return { decision_id: decisionId, outcome: 'admitted' };
  }

  async notify(decisionId: string): Promise<NotifyResult> {
    const row = this.rows.get(decisionId);
    if (!row) return { applied: false, status: 'unknown' };
    if (row.status !== 'raised') return { applied: false, status: row.status };
    row.status = 'notified';
    return { applied: true, status: 'notified' };
  }

  async answer(
    decisionId: string,
    chosenOption: string,
    _answerer: string,
    _now?: string,
  ): Promise<AnswerResult> {
    const row = this.rows.get(decisionId);
    // Missing-row guard (mirrors the real ledger): a no-op, never a throw.
    if (!row) return { applied: false, status: 'unknown' };
    // Off-menu: the chosen option must be one of the offered ids.
    if (!row.options.includes(chosenOption)) {
      throw new FakeOffMenuError(decisionId, chosenOption, row.options);
    }
    // Terminal (resumed): unchanged no-op.
    if (TERMINAL.has(row.status)) {
      return { applied: false, status: row.status };
    }
    // Answer-once: identical re-answer = no-op; conflicting = reject.
    if (row.status === 'answered') {
      if (row.answeredOption === chosenOption) {
        return { applied: false, status: 'answered' };
      }
      throw new FakeAnsweredOnceConflictError(
        decisionId,
        row.answeredOption ?? '?',
        chosenOption,
      );
    }
    row.status = 'answered';
    row.answeredOption = chosenOption;
    return { applied: true, status: 'answered' };
  }

  async statusOf(decisionId: string): Promise<string | undefined> {
    return this.rows.get(decisionId)?.status;
  }

  async advanceToResumed(
    decisionId: string,
    _mode: ResumeMode = 'requeue',
  ): Promise<void> {
    const row = this.rows.get(decisionId);
    if (!row) return;
    if (TERMINAL.has(row.status)) return;
    // Mirror the real ledger: `resumed` is reachable ONLY from the post-answer
    // state. A merely `raised`/`notified` row (never answered) is a no-op here —
    // the real writer's write_response → resume chain only runs from the answered
    // status. Tests that need a terminal row must use seedResumed(), not smuggle
    // a notified row through advanceToResumed.
    if (row.status !== 'answered') return;
    row.status = 'resumed';
  }

  async reconcile(): Promise<unknown> {
    return undefined;
  }

  async supersede(): Promise<boolean> {
    return false;
  }

  async expireOverdue(): Promise<string[]> {
    return [];
  }

  async revealProtected(): Promise<{ field: string; value: string }> {
    throw new Error('fake ledger: revealProtected is not exercised');
  }

  protectedStore(): ProtectedStore {
    return unusedProtectedStore();
  }
}

export interface FakeDecisionManagerOptions {
  enabled?: boolean;
  available?: boolean;
  ledger?: FakeDecisionLedger;
}

/**
 * The manager facade over a {@link FakeDecisionLedger}, injectable into
 * `startDaemon(config, { decisionManager })`. Tracks the governed-only
 * runtime-degraded marker so the wiring (mark on failure / clear on success) is
 * observable in tests.
 */
export class FakeDecisionManager implements DecisionManagerLike {
  readonly #ledger: FakeDecisionLedger;
  readonly #enabled: boolean;
  #available: boolean;
  #runtimeDegraded = false;
  /** Reasons passed to markRuntimeDegraded(), in order (test assertion surface). */
  readonly degradedMarks: string[] = [];
  /** Number of clearRuntimeDegraded() calls (test assertion surface). */
  degradedClears = 0;

  constructor(opts: FakeDecisionManagerOptions = {}) {
    this.#ledger = opts.ledger ?? new FakeDecisionLedger();
    this.#enabled = opts.enabled ?? true;
    this.#available = opts.available ?? true;
  }

  async init(): Promise<void> {
    /* no-op */
  }
  isEnabled(): boolean {
    return this.#enabled;
  }
  isAvailable(): boolean {
    // Mirror the real manager: a disabled index is never available.
    return this.#enabled && this.#available;
  }
  /**
   * Flip runtime availability AFTER boot (the real manager's `#broken` is
   * init-only, so this models an enabled index that became unreachable at
   * runtime — the boot guard only checks availability at startup).
   */
  setAvailable(value: boolean): void {
    this.#available = value;
  }
  ledger(): FakeDecisionLedger {
    return this.#ledger;
  }
  protectedStore(): ProtectedStore {
    return unusedProtectedStore();
  }
  async revealProtected(): Promise<{ field: string; value: string }> {
    throw new Error('fake manager: revealProtected is not exercised');
  }
  async close(): Promise<void> {
    /* no-op */
  }
  markRuntimeDegraded(reason: string): void {
    this.#runtimeDegraded = true;
    this.degradedMarks.push(reason);
  }
  clearRuntimeDegraded(): void {
    this.#runtimeDegraded = false;
    this.degradedClears += 1;
  }
  isRuntimeDegraded(): boolean {
    return this.#runtimeDegraded;
  }
}

/**
 * Build a fake manager + its ledger. Inject the manager into the daemon via
 * `startDaemon(config, { decisionManager: asDecisionManager(fake) })`.
 */
export function createFakeDecisionManager(
  opts: FakeDecisionManagerOptions = {},
): { manager: FakeDecisionManager; ledger: FakeDecisionLedger } {
  const ledger = opts.ledger ?? new FakeDecisionLedger();
  const manager = new FakeDecisionManager({ ...opts, ledger });
  return { manager, ledger };
}

/**
 * Cast the structural fake to the nominal `DecisionIndexManager` the daemon's
 * injection seam (`StartDaemonOptions.decisionManager`) expects. The seam asserts
 * above guarantee the fake covers every method the daemon touches.
 */
export function asDecisionManager(
  fake: FakeDecisionManager,
): DecisionIndexManager {
  return fake as unknown as DecisionIndexManager;
}

/** A typed DecisionView list (the fake never returns one, but the seam imports it). */
export type FakeDecisionViews = DecisionView[];
