/**
 * lifecycle.integration.test.ts — end-to-end (T7) integration over a REAL
 * `@auto-claude/decision-index` writer (native better-sqlite3, real migrations)
 * driven through the daemon's real entry points: `DecisionIndexManager` +
 * `buildL2GateRequest`. NOTHING in the index layer is mocked here.
 *
 * The daemon unit suite (`daemon.test.ts`) mocks `./phases.js` and `./pipeline.js`,
 * so the real park-raise + answer/advance verbs only execute against a stub there.
 * This test closes that gap: it exercises the full `buildL2GateRequest → manager
 * → ledger → IndexWriter → sqlite` stack with the SAME call sequence the daemon
 * uses (raise+notify at the l2-gate park; answer then advanceToResumed on resume),
 * and asserts the ledger lifecycle matches the daemon requeue outcome with no
 * divergence — including the epoch-bumped rework cycle and the disabled no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decisionIndex from '@auto-claude/decision-index';
import { DecisionIndexManager } from './manager.js';
import { buildL2GateRequest, decisionIdFor } from './build-request.js';
import type { DecisionLedger } from './ledger.js';

const TEST_PROTECTED_KEY = Buffer.alloc(32, 7).toString('base64');
const DEPLOYMENT = 'test-owner/test-repo';

/** A minimal parked RunState shaped exactly as `buildL2GateRequest` consumes it. */
function makeRun(
  overrides: Record<string, unknown> = {},
): Parameters<typeof buildL2GateRequest>[0] {
  return {
    issueNumber: 42,
    variant: 'feature',
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    workerClaimId: 'ws-42',
    ...overrides,
  } as unknown as Parameters<typeof buildL2GateRequest>[0];
}

function statusOf(ledger: DecisionLedger, decisionId: string): string | undefined {
  return ledger.pending().find((d) => d.decision_id === decisionId)?.status;
}

describe('decision-escalation lifecycle (real index over temp sqlite)', () => {
  let dir: string;
  let manager: DecisionIndexManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decision-lifecycle-'));
  });
  afterEach(async () => {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function enabledManager(): Promise<DecisionIndexManager> {
    const m = new DecisionIndexManager({
      enabled: true,
      dbPath: join(dir, 'index.sqlite'),
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir: join(dir, 'protected'),
      // no importer override → loads the REAL @auto-claude/decision-index (native)
    });
    await m.init();
    return m;
  }

  it('drives the full l2-gate arc: park(detected, epoch 1) → re-scan dedup → approve → resumed', async () => {
    manager = await enabledManager();
    const ledger = manager.ledger();
    const run = makeRun();

    // --- park side (phases.ts l2-gate handler): raise + notify ---
    const req = buildL2GateRequest(run, 1, DEPLOYMENT);
    const raised = ledger.raise(req);
    expect(raised.outcome).toBe('admitted');
    expect(raised.decision_id).toBe(decisionIdFor('issue-42', 'l2-gate', 1));
    expect(statusOf(ledger, raised.decision_id)).toBe('detected');

    await ledger.notify(raised.decision_id);
    expect(statusOf(ledger, raised.decision_id)).toBe('notified');

    // --- per-tick re-scan: a second raise with the SAME (issue, phase, epoch)
    //     dedupes on the deterministic id — no duplicate row, no IllegalTransition.
    const rescan = ledger.raise(buildL2GateRequest(run, 1, DEPLOYMENT));
    expect(rescan.outcome).toBe('unchanged');
    expect(rescan.decision_id).toBe(raised.decision_id);
    await ledger.notify(raised.decision_id); // re-notify is a status-guarded no-op
    expect(ledger.pending().filter((d) => d.decision_id === raised.decision_id)).toHaveLength(1);
    expect(statusOf(ledger, raised.decision_id)).toBe('notified');

    // --- resume side (resumeParkedRuns): answer recorded BEFORE the requeue save ---
    const ans = ledger.answer(raised.decision_id, 'approve', 'operator');
    expect(ans.applied).toBe(true);
    expect(statusOf(ledger, raised.decision_id)).toBe('answered_pending_source_write');

    // answered-once: a replayed answer (label seen twice) is a no-op.
    const replay = ledger.answer(raised.decision_id, 'approve', 'operator');
    expect(replay.applied).toBe(false);
    expect(statusOf(ledger, raised.decision_id)).toBe('answered_pending_source_write');

    // --- resume side: advance AFTER the save drives the ledger to terminal `resumed` ---
    await ledger.advanceToResumed(raised.decision_id, 'requeue');
    // terminal rows drop out of pending() — the ledger outcome matches the daemon's
    // requeue (the run re-enters the pipeline; the decision is closed out).
    expect(statusOf(ledger, raised.decision_id)).toBeUndefined();
    expect(ledger.pending()).toHaveLength(0);
  });

  it('a second park (rework) bumps the epoch → a DISTINCT decision, independent lifecycle', async () => {
    manager = await enabledManager();
    const ledger = manager.ledger();
    const run = makeRun();

    // Epoch 1: park → approve → resumed (closed out).
    const e1 = ledger.raise(buildL2GateRequest(run, 1, DEPLOYMENT));
    await ledger.notify(e1.decision_id);
    ledger.answer(e1.decision_id, 'approve', 'operator');
    await ledger.advanceToResumed(e1.decision_id, 'requeue');
    expect(statusOf(ledger, e1.decision_id)).toBeUndefined(); // terminal

    // Epoch 2: a fresh park (decisionEpoch bumped) is a brand-new decision row,
    // NOT a dedupe of the epoch-1 id.
    const e2 = ledger.raise(buildL2GateRequest(run, 2, DEPLOYMENT));
    expect(e2.outcome).toBe('admitted');
    expect(e2.decision_id).toBe(decisionIdFor('issue-42', 'l2-gate', 2));
    expect(e2.decision_id).not.toBe(e1.decision_id);
    expect(statusOf(ledger, e2.decision_id)).toBe('detected');

    // Its lifecycle is fully independent of epoch 1.
    await ledger.notify(e2.decision_id);
    expect(statusOf(ledger, e2.decision_id)).toBe('notified');
    expect(ledger.pending().map((d) => d.decision_id)).toEqual([e2.decision_id]);
  });

  it('rejected variant: a "reject" answer is recorded and the ledger requeues to resumed', async () => {
    // The daemon routes a reject back to l2-design (feedback path, covered in
    // daemon.test.ts); the LEDGER lifecycle is identical to approve — requeue.
    manager = await enabledManager();
    const ledger = manager.ledger();
    const run = makeRun({ issueNumber: 77, workerClaimId: 'ws-77' });

    const r = ledger.raise(buildL2GateRequest(run, 1, DEPLOYMENT));
    await ledger.notify(r.decision_id);
    const ans = ledger.answer(r.decision_id, 'reject', 'operator');
    expect(ans.applied).toBe(true);
    expect(statusOf(ledger, r.decision_id)).toBe('answered_pending_source_write');

    await ledger.advanceToResumed(r.decision_id, 'requeue');
    expect(statusOf(ledger, r.decision_id)).toBeUndefined(); // terminal resumed
  });

  it('disabled: init() never imports the native index and ledger() throws (zero interaction)', async () => {
    let importerCalls = 0;
    manager = new DecisionIndexManager({
      enabled: false,
      dbPath: join(dir, 'index.sqlite'),
      protectedKey: TEST_PROTECTED_KEY,
      protectedDir: join(dir, 'protected'),
      importer: async () => {
        importerCalls++;
        return decisionIndex;
      },
    });
    await manager.init();

    // Disabled is the production default — the daemon must do ZERO index work:
    // no native import, no writer, no sqlite file.
    expect(importerCalls).toBe(0);
    expect(manager.isEnabled()).toBe(false);
    expect(() => manager.ledger()).toThrow(/disabled/);
  });
});
