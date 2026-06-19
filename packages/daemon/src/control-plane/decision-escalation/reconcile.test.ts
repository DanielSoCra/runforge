import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@auto-claude/decision-protocol';
import {
  createIndexWriter,
  type IndexWriter,
} from '@auto-claude/decision-index';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from './adapters.js';
import { DecisionLedger } from './ledger.js';
import { bootReconcile, supersedeIfMoot, markOverdue } from './reconcile.js';
import type { DecisionIndexManager } from './manager.js';

const TEST_PROTECTED_KEY = Buffer.alloc(32).toString('base64');
const FIXED_NOW = '2026-06-02T00:00:00.000Z';

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: 'issue-42:l2-gate:1',
    protocol_version: PROTOCOL_VERSION,
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
    // far-future expiry by default; overdue tests override this
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: 'issue-42:l2-gate:1',
    ...overrides,
  };
}

interface TempWriter {
  writer: IndexWriter;
  ledger: DecisionLedger;
  dir: string;
  cleanup: () => void;
}

function makeLedger(): TempWriter {
  const dir = mkdtempSync(join(tmpdir(), 'decision-reconcile-'));
  const writer = createIndexWriter({
    dbPath: join(dir, 'decision-index.sqlite'),
    protectedKey: TEST_PROTECTED_KEY,
    protectedDir: join(dir, 'protected'),
    notifier: new LogNotifier(),
    sourceSink: new RecordingSourceSink(),
    resumeDispatcher: new AckResumeDispatcher(),
    clock: () => new Date(FIXED_NOW),
  });
  const ledger = new DecisionLedger(writer);
  return {
    writer,
    ledger,
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

/** Raise a unique decision and drive it to the requested non-terminal status. */
async function seed(
  t: TempWriter,
  decisionId: string,
  status: 'detected' | 'notified' | 'viewed' | 'answered_pending_source_write' | 'source_written' | 'resume_requested',
  expiresAt = '2026-06-09T00:00:00.000Z',
): Promise<string> {
  const r = t.ledger.raise(
    makeRequest({ decision_id: decisionId, run_id: decisionId, idempotency_key: decisionId, expires_at: expiresAt }),
  );
  if (status === 'detected') return r.decision_id;

  await t.ledger.notify(r.decision_id); // detected -> notified
  if (status === 'notified') return r.decision_id;

  if (status === 'viewed') {
    // opened: notified -> viewed
    t.writer.applyEvent(r.decision_id, 'opened', { semanticKey: 'viewer', now: FIXED_NOW });
    return r.decision_id;
  }

  // answer: notified -> (opened) viewed -> answered_pending_source_write
  t.ledger.answer(r.decision_id, 'approve', 'operator', FIXED_NOW);
  if (status === 'answered_pending_source_write') return r.decision_id;

  // write_response: answered_pending_source_write -> source_written
  await t.writer.runEffect(r.decision_id, 'write_response');
  if (status === 'source_written') return r.decision_id;

  // resume_dispatch: source_written -> resume_requested
  await t.writer.runEffect(r.decision_id, 'requeue');
  // requeue commits resume_dispatch + resume_ack atomically -> resumed, so to
  // leave the row at resume_requested we must NOT use the effect. Instead drive
  // the dispatch event then stop before ack via a direct apply is not exposed;
  // for the test purposes we only need resume_requested as a "skip" case, which
  // the requeue path overshoots to resumed. Callers requesting resume_requested
  // are handled below by leaving it at source_written instead (the requeue effect
  // is atomic), so we never actually need a standalone resume_requested seed.
  return r.decision_id;
}

describe('reconcile (boot reconcile + supersede-on-moot + overdue marking)', () => {
  let t: TempWriter;
  beforeEach(() => (t = makeLedger()));
  afterEach(() => t?.cleanup());

  // ── bootReconcile ────────────────────────────────────────────────────────
  it('bootReconcile: calls ledger().reconcile() exactly once when enabled', async () => {
    let reconcileCalls = 0;
    let ledgerCalls = 0;
    const fakeLedger = {
      reconcile: async () => {
        reconcileCalls++;
        return [];
      },
    } as unknown as DecisionLedger;
    const mgr = {
      isEnabled: () => true,
      ledger: () => {
        ledgerCalls++;
        return fakeLedger;
      },
    } as unknown as DecisionIndexManager;

    await bootReconcile(mgr);
    expect(reconcileCalls).toBe(1);
    expect(ledgerCalls).toBe(1);
  });

  it('bootReconcile: no-op (does not touch ledger) when disabled', async () => {
    let ledgerCalls = 0;
    const mgr = {
      isEnabled: () => false,
      ledger: () => {
        ledgerCalls++;
        throw new Error('decision index disabled');
      },
    } as unknown as DecisionIndexManager;

    await expect(bootReconcile(mgr)).resolves.toBeUndefined();
    expect(ledgerCalls).toBe(0);
  });

  it('bootReconcile: a reconcile error is swallowed (does not throw)', async () => {
    const mgr = {
      isEnabled: () => true,
      ledger: () =>
        ({
          reconcile: async () => {
            throw new Error('boom');
          },
        }) as unknown as DecisionLedger,
    } as unknown as DecisionIndexManager;

    await expect(bootReconcile(mgr)).resolves.toBeUndefined();
  });

  // ── supersedeIfMoot ──────────────────────────────────────────────────────
  it('supersedeIfMoot: supersedes a non-terminal (notified) row', async () => {
    const id = await seed(t, 'issue-1:l2-gate:1', 'notified');
    await supersedeIfMoot(t.ledger, id);
    expect(t.writer.reader.get(id)?.status).toBe('superseded');
  });

  it('supersedeIfMoot: supersedes a detected row (legal from any non-terminal)', async () => {
    const id = await seed(t, 'issue-2:l2-gate:1', 'detected');
    await supersedeIfMoot(t.ledger, id);
    expect(t.writer.reader.get(id)?.status).toBe('superseded');
  });

  it('supersedeIfMoot: SKIPS a terminal (resumed) row without throwing', async () => {
    const id = await seed(t, 'issue-3:l2-gate:1', 'answered_pending_source_write');
    await t.ledger.advanceToResumed(id, 'requeue');
    expect(t.writer.reader.get(id)?.status).toBe('resumed');
    await expect(supersedeIfMoot(t.ledger, id)).resolves.toBeUndefined();
    // unchanged — still resumed, never re-superseded
    expect(t.writer.reader.get(id)?.status).toBe('resumed');
  });

  it('supersedeIfMoot: SKIPS an already-superseded (terminal) row without throwing', async () => {
    const id = await seed(t, 'issue-4:l2-gate:1', 'notified');
    await supersedeIfMoot(t.ledger, id); // -> superseded
    expect(t.writer.reader.get(id)?.status).toBe('superseded');
    // a second call is a no-op (already terminal), must not throw
    await expect(supersedeIfMoot(t.ledger, id)).resolves.toBeUndefined();
    expect(t.writer.reader.get(id)?.status).toBe('superseded');
  });

  it('supersedeIfMoot: SKIPS a missing/undefined row without throwing', async () => {
    expect(t.writer.reader.get('issue-nope:l2-gate:1')).toBeUndefined();
    await expect(supersedeIfMoot(t.ledger, 'issue-nope:l2-gate:1')).resolves.toBeUndefined();
    // still absent
    expect(t.writer.reader.get('issue-nope:l2-gate:1')).toBeUndefined();
  });

  // ── markOverdue ──────────────────────────────────────────────────────────
  it('markOverdue: expires a notified row past expiry (sets stale, stays notified)', async () => {
    const id = await seed(t, 'issue-5:l2-gate:1', 'notified', '2026-06-01T00:00:00.000Z');
    const now = new Date('2026-06-02T00:00:00.000Z'); // past expiry
    await markOverdue(t.ledger, now);
    const view = t.writer.reader.get(id);
    expect(view?.status).toBe('notified'); // expire is non-terminal
    expect(view?.stale).toBe(true);
  });

  it('markOverdue: expires a viewed row past expiry (sets stale, stays viewed)', async () => {
    const id = await seed(t, 'issue-6:l2-gate:1', 'viewed', '2026-06-01T00:00:00.000Z');
    const now = new Date('2026-06-02T00:00:00.000Z');
    await markOverdue(t.ledger, now);
    const view = t.writer.reader.get(id);
    expect(view?.status).toBe('viewed');
    expect(view?.stale).toBe(true);
  });

  it('markOverdue: does NOT touch a notified row that is NOT yet past expiry', async () => {
    const id = await seed(t, 'issue-7:l2-gate:1', 'notified', '2026-06-09T00:00:00.000Z');
    const now = new Date('2026-06-02T00:00:00.000Z'); // before expiry
    await markOverdue(t.ledger, now);
    expect(t.writer.reader.get(id)?.stale).toBe(false);
  });

  it('markOverdue: SKIPS (no throw) past-expiry rows in non-(notified|viewed) states', async () => {
    const now = new Date('2026-06-02T00:00:00.000Z'); // past expiry for the rows below
    const past = '2026-06-01T00:00:00.000Z';

    // detected — expire illegal from here
    const detected = await seed(t, 'issue-8:l2-gate:1', 'detected', past);
    // answered_pending_source_write — expire illegal
    const answered = await seed(t, 'issue-9:l2-gate:1', 'answered_pending_source_write', past);
    // source_written — expire illegal
    const written = await seed(t, 'issue-10:l2-gate:1', 'source_written', past);

    expect(t.writer.reader.get(answered)?.status).toBe('answered_pending_source_write');
    expect(t.writer.reader.get(written)?.status).toBe('source_written');

    // must not throw despite all three being past expiry
    await expect(markOverdue(t.ledger, now)).resolves.toBeUndefined();

    // none of the non-(notified|viewed) rows were touched (not stale, status unchanged)
    expect(t.writer.reader.get(detected)?.status).toBe('detected');
    expect(t.writer.reader.get(detected)?.stale).toBe(false);
    expect(t.writer.reader.get(answered)?.status).toBe('answered_pending_source_write');
    expect(t.writer.reader.get(answered)?.stale).toBe(false);
    expect(t.writer.reader.get(written)?.status).toBe('source_written');
    expect(t.writer.reader.get(written)?.stale).toBe(false);
  });

  it('markOverdue: marks the notified row but skips the source_written row in one sweep', async () => {
    const now = new Date('2026-06-02T00:00:00.000Z');
    const past = '2026-06-01T00:00:00.000Z';
    const notified = await seed(t, 'issue-11:l2-gate:1', 'notified', past);
    const written = await seed(t, 'issue-12:l2-gate:1', 'source_written', past);

    await markOverdue(t.ledger, now);

    expect(t.writer.reader.get(notified)?.stale).toBe(true);
    expect(t.writer.reader.get(written)?.stale).toBe(false);
    expect(t.writer.reader.get(written)?.status).toBe('source_written');
  });
});
