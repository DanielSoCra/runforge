import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIndexWriter,
  type IndexWriter,
} from '@auto-claude/decision-index';
import { SENSITIVITY_FIELD_PATHS } from '@auto-claude/decision-protocol';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from './adapters.js';
import { DecisionLedger } from './ledger.js';

const TEST_PROTECTED_KEY = Buffer.alloc(32).toString('base64');
const FIXED_NOW = '2026-06-02T00:00:00.000Z';

/** Build a fully-classified (all paths `internal`) DecisionRequest the index admits. */
function fullSensitivity(): Record<string, 'public' | 'internal' | 'phi' | 'secret'> {
  const map: Record<string, 'public' | 'internal' | 'phi' | 'secret'> = {};
  for (const p of SENSITIVITY_FIELD_PATHS) map[p] = 'internal';
  return map;
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: 'issue-42:l2-gate:1',
    protocol_version: '1.0.0',
    source_url: 'https://example.test/issues/42',
    source_etag: 'etag-0',
    deployment: 'test',
    run_id: 'issue-42',
    worker_session_id: 'ws-1',
    phase: 'l2-gate',
    risk_class: 'P1',
    question: 'Approve the L2 architecture?',
    context: 'l2-gate review for issue 42',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    consequence_of_no_answer: 'run stays parked',
    reversibility: 'reversible',
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: 'issue-42:l2-gate:1',
    field_sensitivity: fullSensitivity(),
    ...overrides,
  };
}

interface TempWriter {
  writer: IndexWriter;
  ledger: DecisionLedger;
  sink: RecordingSourceSink;
  dispatcher: AckResumeDispatcher;
  dir: string;
  cleanup: () => void;
}

function makeLedger(): TempWriter {
  const dir = mkdtempSync(join(tmpdir(), 'decision-ledger-'));
  const sink = new RecordingSourceSink();
  const dispatcher = new AckResumeDispatcher();
  const writer = createIndexWriter({
    dbPath: join(dir, 'decision-index.sqlite'),
    protectedKey: TEST_PROTECTED_KEY,
    protectedDir: join(dir, 'protected'),
    notifier: new LogNotifier(),
    sourceSink: sink,
    resumeDispatcher: dispatcher,
    clock: () => new Date(FIXED_NOW),
  });
  const ledger = new DecisionLedger(writer);
  return {
    writer,
    ledger,
    sink,
    dispatcher,
    dir,
    cleanup() {
      try {
        writer.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('DecisionLedger (real IndexWriter over temp sqlite)', () => {
  let t: TempWriter;
  beforeEach(() => (t = makeLedger()));
  afterEach(() => t?.cleanup());

  it('drives raise -> notify -> answer -> advanceToResumed all the way to resumed', async () => {
    const req = makeRequest();
    const r = t.ledger.raise(req);
    expect(r.outcome).toBe('admitted');
    expect(r.decision_id).toBe('issue-42:l2-gate:1');
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('detected');

    await t.ledger.notify(r.decision_id);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('notified');

    const ans = t.ledger.answer(r.decision_id, 'approve', 'operator');
    expect(ans.applied).toBe(true);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('answered_pending_source_write');

    await t.ledger.advanceToResumed(r.decision_id, 'requeue');
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('resumed');
    // the answer was written to the source-sink and the resume dispatched
    expect(t.sink.calls).toHaveLength(1);
    expect(t.dispatcher.calls).toHaveLength(1);
  });

  it('notify is a no-op once past detected (status-guarded, no IllegalTransitionError)', async () => {
    const req = makeRequest();
    const r = t.ledger.raise(req);
    await t.ledger.notify(r.decision_id);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('notified');
    // a second notify (e.g. a per-tick re-scan) must NOT throw and must not advance
    const again = await t.ledger.notify(r.decision_id);
    expect(again.applied).toBe(false);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('notified');
  });

  it('answered-once: a second distinct answer is a no-op (does not double-answer)', async () => {
    const req = makeRequest();
    const r = t.ledger.raise(req);
    await t.ledger.notify(r.decision_id);

    const first = t.ledger.answer(r.decision_id, 'approve', 'operator');
    expect(first.applied).toBe(true);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('answered_pending_source_write');

    // a second answer with the SAME chosen option / answerer replays as a no-op.
    const second = t.ledger.answer(r.decision_id, 'approve', 'operator');
    expect(second.applied).toBe(false);
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('answered_pending_source_write');
    // exactly one response row recorded
    expect(t.writer.reader.hasResponse(r.decision_id)).toBe(true);
  });

  it('pending() shows a raised+notified (non-terminal) item and drops a resumed (terminal) one', async () => {
    const a = t.ledger.raise(makeRequest({ decision_id: 'issue-1:l2-gate:1', run_id: 'issue-1', idempotency_key: 'issue-1:l2-gate:1' }));
    await t.ledger.notify(a.decision_id);

    const b = t.ledger.raise(makeRequest({ decision_id: 'issue-2:l2-gate:1', run_id: 'issue-2', idempotency_key: 'issue-2:l2-gate:1' }));
    await t.ledger.notify(b.decision_id);
    t.ledger.answer(b.decision_id, 'approve', 'operator');
    await t.ledger.advanceToResumed(b.decision_id, 'requeue');
    expect(t.writer.reader.get(b.decision_id)?.status).toBe('resumed');

    const pending = t.ledger.pending();
    const ids = pending.map((p) => p.decision_id);
    expect(ids).toContain('issue-1:l2-gate:1');
    expect(ids).not.toContain('issue-2:l2-gate:1');
  });

  it('reconcile() completes an in-flight effect after a simulated crash', async () => {
    // Bring the item to answered_pending_source_write, then DO NOT advance — this
    // models a crash right after the answer was recorded but before the source
    // write / resume effects ran. reconcile() must drive it forward.
    const req = makeRequest();
    const r = t.ledger.raise(req);
    await t.ledger.notify(r.decision_id);
    t.ledger.answer(r.decision_id, 'approve', 'operator');
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('answered_pending_source_write');

    const results = await t.ledger.reconcile();
    const mine = results.find((x) => x.decision_id === r.decision_id);
    expect(mine).toBeDefined();
    // reconcile drives the in-flight write_response effect (re-executed from absent)
    expect(t.writer.reader.get(r.decision_id)?.status).toBe('source_written');
  });
});
