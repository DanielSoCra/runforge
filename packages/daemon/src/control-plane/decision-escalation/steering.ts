/**
 * steering.ts — v2 operator→run steering (notes + run controls).
 *
 * The reverse-direction sibling of v1's `DecisionLedger`: a thin daemon-facing
 * facade over a durable `InMemorySteeringStore`. Every verb returns an explicit
 * `{accepted, outcome, reason}` result, records guidance before it takes effect,
 * dedupes on deterministic ids, and is fail-safe on a missing or finished run.
 *
 * Notes and redirects are applied ONLY at phase boundaries; abort respects the
 * run's safe-point signal. Steering governs pace and direction — it never
 * bypasses a gate, answers a decision, merges, or widens scope.
 */
import { randomUUID } from 'node:crypto';

/** The run identity a steering item is scoped to. */
export interface SteeringRunRef {
  runId: string;
  generation: number;
  phase: string;
  phaseSeq: number;
  status: 'running' | 'held' | 'aborted' | 'completed';
}

/** A note that has been delivered at a phase boundary and is still active. */
export interface ActiveNote {
  noteId: string;
  body: string;
  kind: 'note';
}

/** Result of attempting to send a note. */
export interface SendNoteResult {
  accepted: boolean;
  noteId?: string;
  outcome: 'queued' | 'duplicate' | 'stale' | 'undeliverable' | 'not-found';
  reason?: string;
}

/** Result of delivering notes at a phase boundary. */
export interface DeliverNotesResult {
  delivered: ActiveNote[];
  gateBypassed?: boolean;
  decisionAnswered?: boolean;
  scopeWidened?: boolean;
}

/** Result of attempting a run control (pause / resume / redirect / abort). */
export interface ControlResult {
  accepted: boolean;
  outcome: 'queued' | 'duplicate' | 'stale' | 'undeliverable' | 'not-found' | 'not-held';
  reason?: string;
  controlId?: string;
}

/** Directive the daemon pipeline honors at a phase boundary. */
export interface BoundaryDirective {
  directive: 'proceed' | 'hold' | 'redirect' | 'abort';
  direction?: string;
  discardPriorWork?: boolean;
  partialWorkPreserved?: boolean;
  partialWorkLabel?: string;
  gateBypassed?: boolean;
  decisionAnswered?: boolean;
  merged?: boolean;
  scopeWidened?: boolean;
}

/** A recorded control in the run's steering history. */
export interface ControlRecord {
  controlId: string;
  control: 'pause' | 'redirect' | 'abort' | 'resume';
  operator: string;
  reason?: string;
  direction?: string;
  againstPhaseSeq?: number;
  appliedAtPhaseSeq?: number;
}

/** Return receipt for guidance that could not be delivered. */
export interface ReturnReceipt {
  runId: string;
  operator: string;
  body: string;
  outcome: 'stale' | 'undeliverable' | 'not-found';
  reason?: string;
  recordedAt: string;
}

/** Internal durable representation of a queued note. */
interface StoredNote {
  noteId: string;
  runId: string;
  generation: number;
  operator: string;
  body: string;
  againstPhaseSeq: number;
  delivered: boolean;
  deliveredAtPhaseSeq?: number;
}

/** Internal durable representation of a run control. */
interface StoredControl {
  controlId: string;
  runId: string;
  generation: number;
  operator: string;
  control: 'pause' | 'redirect' | 'abort' | 'resume';
  againstPhaseSeq?: number;
  direction?: string;
  reason?: string;
  applied: boolean;
  appliedAtPhaseSeq?: number;
}

/**
 * In-memory durable steering store. Survives `SteeringLedger` reconstruction:
 * constructing a second ledger over the same store sees every prior note,
 * control, and return receipt.
 */
export class InMemorySteeringStore {
  readonly runs = new Map<string, SteeringRunRef>();
  readonly notes = new Map<string, StoredNote>();
  readonly controls = new Map<string, StoredControl>();
  readonly receipts = new Map<string, ReturnReceipt>();

  upsertRun(ref: SteeringRunRef): void {
    this.runs.set(ref.runId, ref);
  }

  getRun(runId: string): SteeringRunRef | undefined {
    return this.runs.get(runId);
  }

  noteIdFor(runId: string, generation: number, idempotencyKey: string): string {
    return `${runId}:${generation}:note:${idempotencyKey}`;
  }

  controlIdFor(
    runId: string,
    generation: number,
    control: StoredControl['control'],
    idempotencyKey: string,
  ): string {
    return `${runId}:${generation}:control:${control}:${idempotencyKey}`;
  }
}

export class SteeringLedger {
  constructor(private readonly store: InMemorySteeringStore) {}

  sendNote(
    runId: string,
    payload: {
      operator: string;
      body: string;
      againstPhaseSeq: number;
      idempotencyKey?: string;
    },
  ): SendNoteResult {
    const { operator, body, againstPhaseSeq, idempotencyKey } = payload;
    const run = this.store.getRun(runId);

    if (run === undefined) {
      this.recordReceipt(runId, operator, body, 'not-found', 'Run not found');
      return { accepted: false, outcome: 'not-found', reason: 'Run not found' };
    }

    if (idempotencyKey !== undefined) {
      const deterministicId = this.store.noteIdFor(runId, run.generation, idempotencyKey);
      const existing = this.store.notes.get(deterministicId);
      if (existing !== undefined) {
        return { accepted: true, outcome: 'duplicate', noteId: existing.noteId };
      }
    }

    if (run.status === 'completed' || run.status === 'aborted') {
      this.recordReceipt(runId, operator, body, 'undeliverable', `Run is ${run.status}`);
      return {
        accepted: false,
        outcome: 'undeliverable',
        reason: `Run is ${run.status}`,
      };
    }

    if (run.phaseSeq > againstPhaseSeq) {
      this.recordReceipt(
        runId,
        operator,
        body,
        'stale',
        `Run has moved past phaseSeq ${againstPhaseSeq}`,
      );
      return {
        accepted: false,
        outcome: 'stale',
        reason: `Run has moved past phaseSeq ${againstPhaseSeq}`,
      };
    }

    const noteId: string =
      idempotencyKey !== undefined
        ? this.store.noteIdFor(runId, run.generation, idempotencyKey)
        : randomUUID();

    this.store.notes.set(noteId, {
      noteId,
      runId,
      generation: run.generation,
      operator,
      body,
      againstPhaseSeq,
      delivered: false,
    });

    return { accepted: true, outcome: 'queued', noteId };
  }

  deliverNotesAtBoundary(
    runId: string,
    boundary: { phaseSeq: number; phase: string; generation?: number },
  ): DeliverNotesResult {
    const run = this.store.getRun(runId);
    if (run === undefined) {
      return { delivered: [], gateBypassed: false, decisionAnswered: false, scopeWidened: false };
    }
    // Stale-generation boundary event → no-op: a successor generation never inherits prior guidance.
    if (boundary.generation !== undefined && boundary.generation !== run.generation) {
      return { delivered: [], gateBypassed: false, decisionAnswered: false, scopeWidened: false };
    }
    const targetGeneration = run.generation;

    if (run.status === 'aborted' || run.status === 'completed') {
      return { delivered: [], gateBypassed: false, decisionAnswered: false, scopeWidened: false };
    }

    const delivered: ActiveNote[] = [];
    for (const note of this.store.notes.values()) {
      if (note.runId !== runId) continue;
      if (note.generation !== targetGeneration) continue;
      if (note.delivered) continue;
      if (note.againstPhaseSeq < boundary.phaseSeq) {
        note.delivered = true;
        note.deliveredAtPhaseSeq = boundary.phaseSeq;
        delivered.push({ noteId: note.noteId, body: note.body, kind: 'note' });
      }
    }

    return {
      delivered,
      gateBypassed: false,
      decisionAnswered: false,
      scopeWidened: false,
    };
  }

  activeNotes(runId: string): ActiveNote[] {
    const run = this.store.getRun(runId);
    const targetGeneration = run?.generation;
    if (run === undefined || targetGeneration === undefined) {
      return [];
    }

    const active: ActiveNote[] = [];
    for (const note of this.store.notes.values()) {
      if (note.runId !== runId) continue;
      if (note.generation !== targetGeneration) continue;
      if (!note.delivered) continue;
      active.push({ noteId: note.noteId, body: note.body, kind: 'note' });
    }
    return active;
  }

  returnedToOperator(operator: string): ReturnReceipt[] {
    const receipts: ReturnReceipt[] = [];
    for (const receipt of this.store.receipts.values()) {
      if (receipt.operator === operator) {
        receipts.push(receipt);
      }
    }
    return receipts.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  pause(
    runId: string,
    payload: { operator: string; againstPhaseSeq: number; idempotencyKey?: string },
  ): ControlResult {
    return this.queueControl(runId, 'pause', payload);
  }

  resume(runId: string, payload: { operator: string }): ControlResult {
    const run = this.store.getRun(runId);
    if (run === undefined) {
      this.recordReceipt(runId, payload.operator, '', 'not-found', 'Run not found');
      return { accepted: false, outcome: 'not-found', reason: 'Run not found' };
    }

    if (run.status !== 'held') {
      return { accepted: false, outcome: 'not-held', reason: 'Run is not held' };
    }

    this.store.upsertRun({ ...run, status: 'running' });
    const controlId = randomUUID();
    this.store.controls.set(controlId, {
      controlId,
      runId,
      generation: run.generation,
      operator: payload.operator,
      control: 'resume',
      applied: true,
    });

    return { accepted: true, outcome: 'queued', controlId };
  }

  redirect(
    runId: string,
    payload: {
      operator: string;
      direction: string;
      againstPhaseSeq: number;
      idempotencyKey?: string;
    },
  ): ControlResult {
    return this.queueControl(runId, 'redirect', payload);
  }

  abort(runId: string, payload: { operator: string; reason: string }): ControlResult {
    const run = this.store.getRun(runId);
    if (run === undefined) {
      this.recordReceipt(runId, payload.operator, '', 'not-found', 'Run not found');
      return { accepted: false, outcome: 'not-found', reason: 'Run not found' };
    }

    if (run.status === 'completed' || run.status === 'aborted') {
      this.recordReceipt(
        runId,
        payload.operator,
        '',
        'undeliverable',
        `Run is ${run.status}`,
      );
      return {
        accepted: false,
        outcome: 'undeliverable',
        reason: `Run is ${run.status}`,
      };
    }

    // Do NOT mark the run aborted at request time — the abort only takes effect
    // at the earliest safe point (directiveAtBoundary), never mid-write. Queue
    // it as a pending control; status transitions there.
    const controlId = randomUUID();
    this.store.controls.set(controlId, {
      controlId,
      runId,
      generation: run.generation,
      operator: payload.operator,
      control: 'abort',
      reason: payload.reason,
      applied: false,
    });

    return { accepted: true, outcome: 'queued', controlId };
  }

  directiveAtBoundary(
    runId: string,
    boundary: { phaseSeq: number; phase: string; generation?: number; safePoint?: boolean },
  ): BoundaryDirective {
    const run = this.store.getRun(runId);
    const baseFlags = {
      gateBypassed: false,
      decisionAnswered: false,
      merged: false,
      scopeWidened: false,
    };

    if (run === undefined) {
      return { directive: 'proceed', ...baseFlags };
    }
    // Stale-generation boundary event → no-op: never act on a different generation's guidance.
    if (boundary.generation !== undefined && boundary.generation !== run.generation) {
      return { directive: 'proceed', ...baseFlags };
    }
    const targetGeneration = run.generation;

    const isSafe = boundary.safePoint !== false;

    const abortControl = this.findControl(runId, targetGeneration, 'abort');
    if (abortControl !== undefined) {
      if (!isSafe) {
        return { directive: 'proceed', ...baseFlags };
      }
      if (run.status !== 'aborted') {
        this.store.upsertRun({ ...run, status: 'aborted' });
      }
      abortControl.applied = true;
      abortControl.appliedAtPhaseSeq = boundary.phaseSeq;
      return {
        directive: 'abort',
        partialWorkPreserved: true,
        partialWorkLabel: 'abandoned',
        discardPriorWork: false,
        ...baseFlags,
      };
    }

    if (run.status === 'held') {
      return { directive: 'hold', ...baseFlags };
    }

    const pendingPause = this.findPendingControl(runId, targetGeneration, 'pause', boundary.phaseSeq);
    if (pendingPause !== undefined) {
      pendingPause.applied = true;
      pendingPause.appliedAtPhaseSeq = boundary.phaseSeq;
      this.store.upsertRun({ ...run, status: 'held' });
      return { directive: 'hold', ...baseFlags };
    }

    const pendingRedirect = this.findPendingControl(
      runId,
      targetGeneration,
      'redirect',
      boundary.phaseSeq,
    );
    if (pendingRedirect !== undefined) {
      pendingRedirect.applied = true;
      pendingRedirect.appliedAtPhaseSeq = boundary.phaseSeq;
      return {
        directive: 'redirect',
        direction: pendingRedirect.direction,
        discardPriorWork: false,
        ...baseFlags,
      };
    }

    return { directive: 'proceed', ...baseFlags };
  }

  controlHistory(runId: string): ControlRecord[] {
    const run = this.store.getRun(runId);
    const targetGeneration = run?.generation;
    if (run === undefined || targetGeneration === undefined) {
      return [];
    }

    const history: ControlRecord[] = [];
    for (const control of this.store.controls.values()) {
      if (control.runId !== runId) continue;
      if (control.generation !== targetGeneration) continue;
      history.push({
        controlId: control.controlId,
        control: control.control,
        operator: control.operator,
        reason: control.reason,
        direction: control.direction,
        againstPhaseSeq: control.againstPhaseSeq,
        appliedAtPhaseSeq: control.appliedAtPhaseSeq,
      });
    }
    return history.sort((a, b) =>
      (a.appliedAtPhaseSeq ?? 0) === (b.appliedAtPhaseSeq ?? 0)
        ? a.controlId.localeCompare(b.controlId)
        : (a.appliedAtPhaseSeq ?? 0) - (b.appliedAtPhaseSeq ?? 0),
    );
  }

  private queueControl(
    runId: string,
    control: 'pause' | 'redirect',
    payload:
      | { operator: string; againstPhaseSeq: number; idempotencyKey?: string }
      | { operator: string; direction: string; againstPhaseSeq: number; idempotencyKey?: string },
  ): ControlResult {
    const operator = payload.operator;
    const againstPhaseSeq = payload.againstPhaseSeq;
    const idempotencyKey = payload.idempotencyKey;
    const direction = 'direction' in payload ? payload.direction : undefined;
    const run = this.store.getRun(runId);

    if (run === undefined) {
      this.recordReceipt(runId, operator, '', 'not-found', 'Run not found');
      return { accepted: false, outcome: 'not-found', reason: 'Run not found' };
    }

    if (idempotencyKey !== undefined) {
      const deterministicId = this.store.controlIdFor(runId, run.generation, control, idempotencyKey);
      const existing = this.store.controls.get(deterministicId);
      if (existing !== undefined) {
        return { accepted: true, outcome: 'duplicate', controlId: existing.controlId };
      }
    }

    if (run.status === 'completed' || run.status === 'aborted') {
      this.recordReceipt(runId, operator, '', 'undeliverable', `Run is ${run.status}`);
      return {
        accepted: false,
        outcome: 'undeliverable',
        reason: `Run is ${run.status}`,
      };
    }

    if (run.phaseSeq > againstPhaseSeq) {
      this.recordReceipt(
        runId,
        operator,
        '',
        'stale',
        `Run has moved past phaseSeq ${againstPhaseSeq}`,
      );
      return {
        accepted: false,
        outcome: 'stale',
        reason: `Run has moved past phaseSeq ${againstPhaseSeq}`,
      };
    }

    const controlId: string =
      idempotencyKey !== undefined
        ? this.store.controlIdFor(runId, run.generation, control, idempotencyKey)
        : randomUUID();

    this.store.controls.set(controlId, {
      controlId,
      runId,
      generation: run.generation,
      operator,
      control,
      againstPhaseSeq,
      direction,
      applied: false,
    });

    return { accepted: true, outcome: 'queued', controlId };
  }

  private findControl(
    runId: string,
    generation: number,
    control: StoredControl['control'],
  ): StoredControl | undefined {
    for (const c of this.store.controls.values()) {
      if (c.runId === runId && c.generation === generation && c.control === control) {
        return c;
      }
    }
    return undefined;
  }

  private findPendingControl(
    runId: string,
    generation: number,
    control: StoredControl['control'],
    phaseSeq: number,
  ): StoredControl | undefined {
    for (const c of this.store.controls.values()) {
      if (
        c.runId === runId &&
        c.generation === generation &&
        c.control === control &&
        !c.applied &&
        c.againstPhaseSeq !== undefined &&
        c.againstPhaseSeq < phaseSeq
      ) {
        return c;
      }
    }
    return undefined;
  }

  private recordReceipt(
    runId: string,
    operator: string,
    body: string,
    outcome: 'stale' | 'undeliverable' | 'not-found',
    reason: string,
  ): void {
    const recordedAt = new Date().toISOString();
    this.store.receipts.set(`${operator}:${recordedAt}:${runId}:${randomUUID()}`, {
      runId,
      operator,
      body,
      outcome,
      reason,
      recordedAt,
    });
  }
}
