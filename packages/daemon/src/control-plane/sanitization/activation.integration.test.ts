// GATE (immovable) — end-to-end backend activation over the REAL ProtectedStore.
//
// Proves the load-bearing 5a invariant: a configured withholding sanitizer, wired to the
// SAME ProtectedStore the decision ledger owns (single writable connection), withholds a
// field at ingest AND the original is recoverable via the store ref — which is exactly what
// the operator-surface reveal (5b) will decrypt. If this round-trips, reveal is possible.
//
// It also pins the exposure path: DecisionIndexManager.protectedStore() returns the live
// store when enabled, and throws when the index is disabled (fail-closed, mirroring ledger()).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWithholdingFactory } from '@auto-claude/sanitizer-redaction';
import { DecisionIndexManager } from '../decision-escalation/manager.js';

const KEY = Buffer.alloc(32, 7).toString('base64'); // deterministic 32-byte AES-256 key
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pmps-act-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function enabledManager(): Promise<DecisionIndexManager> {
  const state = tmp();
  const mgr = new DecisionIndexManager({
    enabled: true,
    dbPath: join(state, 'decision-index.sqlite'),
    protectedKey: KEY,
    protectedDir: join(state, 'protected'),
  });
  await mgr.init();
  return mgr;
}

describe('sanitizer activation — real store round-trip', () => {
  it('withholds a field at ingest and recovers the original via the store ref', async () => {
    const mgr = await enabledManager();
    const store = mgr.protectedStore();

    const sanitizer = createWithholdingFactory(store)({ fields: ['context'], class: 'secret' });
    const result = sanitizer.sanitize({
      content: { question: 'q?', context: 'SENSITIVE-VALUE' },
      subjectRef: 'dec-round-trip-1',
    });

    // withheld at the boundary
    expect(result.content.question).toBe('q?');
    expect(result.content.context).toBe('[WITHHELD]');
    const wh = result.withholdings.find((w) => w.field === 'context');
    expect(wh).toBeDefined();

    // recoverable by the SAME store the read-model/reveal will use (crypto round-trips)
    expect(store.get(wh!.ref)).toBe(JSON.stringify('SENSITIVE-VALUE'));

    await mgr.close();
  });

  it('exposes the protected store only when the index is enabled (fail-closed otherwise)', async () => {
    const disabled = new DecisionIndexManager({
      enabled: false,
      dbPath: 'unused.sqlite',
      protectedKey: '',
      protectedDir: 'unused',
    });
    await disabled.init();
    expect(() => disabled.protectedStore()).toThrow();
  });
});
