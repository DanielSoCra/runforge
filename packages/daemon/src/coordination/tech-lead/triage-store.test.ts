// packages/daemon/src/coordination/tech-lead/triage-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TriageStore } from './triage-store.js';

describe('TriageStore', () => {
  let path: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'triage-store-'));
    path = join(dir, 'triage-state.json');
  });

  it('initializes with zero approvals for today', async () => {
    const store = new TriageStore(path);
    const remaining = await store.remaining(5);
    expect(remaining).toBe(5);
  });

  it('decrements remaining after increment', async () => {
    const store = new TriageStore(path);
    await store.increment(2);
    const remaining = await store.remaining(5);
    expect(remaining).toBe(3);
  });

  it('resets counter when date changes', async () => {
    const store = new TriageStore(path);
    await store.increment(3);

    // Simulate a store from yesterday by writing directly
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { writeJsonSafe } = await import('../../lib/json-store.js');
    await writeJsonSafe(path, { date: yesterday, approvedCount: 3 });

    const remaining = await store.remaining(5);
    expect(remaining).toBe(5);
  });
});
