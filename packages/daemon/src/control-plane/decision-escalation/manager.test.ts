import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@auto-claude/decision-protocol';
import * as decisionIndex from '@auto-claude/decision-index';
import { DecisionIndexManager } from './manager.js';

const TEST_PROTECTED_KEY = Buffer.alloc(32).toString('base64');

function makeRequest(): Record<string, unknown> {
  return {
    decision_id: 'issue-7:l2-gate:1',
    protocol_version: PROTOCOL_VERSION,
    source_url: 'https://example.test/issues/7',
    source_etag: 'etag-0',
    deployment: 'test',
    run_id: 'issue-7',
    worker_session_id: 'ws-1',
    phase: 'l2-gate',
    risk_class: 'P1',
    question: 'Approve?',
    context: 'ctx',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    consequence_of_no_answer: 'parked',
    reversibility: 'reversible',
    expires_at: '2026-06-09T00:00:00.000Z',
    answer_schema: { kind: 'option' },
    resume_mode: 'requeue',
    idempotency_key: 'issue-7:l2-gate:1',
  };
}

describe('DecisionIndexManager', () => {
  let tmpDirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'decision-mgr-'));
    tmpDirs.push(d);
    return d;
  };

  beforeEach(() => {
    tmpDirs = [];
  });
  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('disabled: init() never calls the importer, isEnabled() is false, ledger() throws /disabled/', async () => {
    let importerCalls = 0;
    const mgr = new DecisionIndexManager({
      enabled: false,
      dbPath: join(tmp(), 'x.sqlite'),
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir: join(tmp(), 'protected'),
      importer: async () => {
        importerCalls++;
        return decisionIndex;
      },
    });
    await mgr.init();
    expect(importerCalls).toBe(0);
    expect(mgr.isEnabled()).toBe(false);
    expect(() => mgr.ledger()).toThrow(/disabled/);
    await mgr.close();
  });

  it('enabled (fake importer over temp sqlite): ledger() works end-to-end', async () => {
    const dir = tmp();
    let importerCalls = 0;
    const mgr = new DecisionIndexManager({
      enabled: true,
      dbPath: join(dir, 'decision-index.sqlite'),
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir: join(dir, 'protected'),
      importer: async () => {
        importerCalls++;
        return decisionIndex;
      },
    });
    await mgr.init();
    expect(importerCalls).toBe(1);
    expect(mgr.isEnabled()).toBe(true);

    const ledger = mgr.ledger();
    const r = ledger.raise(makeRequest());
    expect(r.outcome).toBe('admitted');
    await ledger.notify(r.decision_id);
    const ans = ledger.answer(r.decision_id, 'approve', 'operator');
    expect(ans.applied).toBe(true);
    await ledger.advanceToResumed(r.decision_id, 'requeue');
    // end-to-end: reached terminal resumed
    expect(ledger.pending().map((d) => d.decision_id)).not.toContain(r.decision_id);
    await mgr.close();
  });

  it('enabled but importer throws: ledger() throws /unavailable/ (fail-closed), daemon keeps running', async () => {
    const mgr = new DecisionIndexManager({
      enabled: true,
      dbPath: join(tmp(), 'decision-index.sqlite'),
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir: join(tmp(), 'protected'),
      importer: async () => {
        throw new Error('native load failed');
      },
    });
    // init() must NOT throw — the daemon keeps running.
    await expect(mgr.init()).resolves.toBeUndefined();
    expect(mgr.isEnabled()).toBe(true);
    expect(() => mgr.ledger()).toThrow(/unavailable/);
    await mgr.close();
  });
});
