import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLaneOutcome, laneOutcomesPath, loadLaneOutcomes } from './outcome-ledger.js';

describe('outcome-ledger', () => {
  const dirs: string[] = [];
  const tmpDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'p4-earnin-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
  });

  it('appends and reloads clean-merge, bounce, and red outcomes', async () => {
    const stateDir = tmpDir();
    await appendLaneOutcome(stateDir, { ts: new Date().toISOString(), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' });
    await appendLaneOutcome(stateDir, {
      ts: new Date().toISOString(),
      deploymentId: 'dep-a',
      lane: 'fast',
      kind: 'bounce',
      bounceReason: 'scope-tripwire',
    });
    await appendLaneOutcome(stateDir, {
      ts: new Date().toISOString(),
      deploymentId: 'dep-a',
      lane: 'fast',
      kind: 'red',
      redReason: 'failed-release',
    });

    const loaded = await loadLaneOutcomes(laneOutcomesPath(stateDir));
    expect(loaded).toHaveLength(3);
    expect(loaded.map((o) => o.kind)).toEqual(['clean-merge', 'bounce', 'red']);
    expect(loaded.find((o) => o.kind === 'bounce')?.bounceReason).toBe('scope-tripwire');
    expect(loaded.find((o) => o.kind === 'red')?.redReason).toBe('failed-release');
  });

  it('prunes events older than retentionMs but keeps fresh ones', async () => {
    const stateDir = tmpDir();
    const now = Date.now();
    const stale = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    await appendLaneOutcome(stateDir, { ts: stale, deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' }, 90 * 24 * 60 * 60 * 1000);
    await appendLaneOutcome(stateDir, { ts: fresh, deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' }, 90 * 24 * 60 * 60 * 1000);

    const loaded = await loadLaneOutcomes(laneOutcomesPath(stateDir));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.ts).toBe(fresh);
  });

  it('drops malformed entries on load', async () => {
    const stateDir = tmpDir();
    const path = laneOutcomesPath(stateDir);
    await appendLaneOutcome(stateDir, { ts: new Date().toISOString(), deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' });
    const existing = await loadLaneOutcomes(path);
    existing.push({ ts: 'bad-timestamp', deploymentId: 'dep-a', lane: 'fast', kind: 'clean-merge' } as typeof existing[0]);
    await appendLaneOutcome(stateDir, { ts: new Date().toISOString(), deploymentId: 'dep-a', lane: 'fast', kind: 'bounce' });

    const loaded = await loadLaneOutcomes(path);
    expect(loaded).toHaveLength(2);
    expect(loaded.every((o) => o.kind === 'clean-merge' || o.kind === 'bounce')).toBe(true);
  });

  it('returns empty array for a missing file', async () => {
    const stateDir = tmpDir();
    const loaded = await loadLaneOutcomes(join(stateDir, 'nonexistent.json'));
    expect(loaded).toEqual([]);
  });
});
