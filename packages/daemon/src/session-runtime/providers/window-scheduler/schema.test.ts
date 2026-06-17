// packages/daemon/src/session-runtime/providers/window-scheduler/schema.test.ts
import { describe, it, expect } from 'vitest';
import { PoolConfigSchema, validatePoolMembership } from './schema.js';
import type { PoolConfig } from './types.js';

const validRaw = {
  name: 'sub-a',
  providers: ['p1', 'p2'],
  window: { lengthMs: 18_000_000, reset: 'rolling-from-first-use' },
  signalSources: ['retry-after', 'reported-quota'],
  preferenceRank: 0,
};

describe('PoolConfigSchema', () => {
  it('parses a valid PoolConfig', () => {
    const r = PoolConfigSchema.safeParse(validRaw);
    expect(r.success).toBe(true);
  });

  it('rejects an unknown key (.strict())', () => {
    const r = PoolConfigSchema.safeParse({ ...validRaw, accountId: 'oops' });
    expect(r.success).toBe(false);
  });

  it('rejects empty providers (.nonempty())', () => {
    const r = PoolConfigSchema.safeParse({ ...validRaw, providers: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a non-positive window length', () => {
    expect(PoolConfigSchema.safeParse({ ...validRaw, window: { lengthMs: 0, reset: 'fixed-schedule' } }).success).toBe(false);
    expect(PoolConfigSchema.safeParse({ ...validRaw, window: { lengthMs: -1, reset: 'fixed-schedule' } }).success).toBe(false);
  });

  // --- Plan-2: optional capacity / threshold knobs --------------------------

  it('accepts a config with capacity and threshold ABSENT (Plan-1 inert default)', () => {
    // The base fixture declares neither — they MUST be optional (the shared
    // deployment-registry FleetCapacity fixtures rely on this).
    const r = PoolConfigSchema.safeParse(validRaw);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capacity).toBeUndefined();
      expect(r.data.threshold).toBeUndefined();
    }
  });

  it('accepts a present-and-valid capacity (positive number) and threshold (positive int)', () => {
    const r = PoolConfigSchema.safeParse({ ...validRaw, capacity: 1000, threshold: 3 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capacity).toBe(1000);
      expect(r.data.threshold).toBe(3);
    }
  });

  it('rejects a non-positive capacity (0 / negative)', () => {
    expect(PoolConfigSchema.safeParse({ ...validRaw, capacity: 0 }).success).toBe(false);
    expect(PoolConfigSchema.safeParse({ ...validRaw, capacity: -1 }).success).toBe(false);
  });

  it('rejects a non-positive or non-integer threshold (0 / negative / fractional)', () => {
    expect(PoolConfigSchema.safeParse({ ...validRaw, threshold: 0 }).success).toBe(false);
    expect(PoolConfigSchema.safeParse({ ...validRaw, threshold: -2 }).success).toBe(false);
    expect(PoolConfigSchema.safeParse({ ...validRaw, threshold: 2.5 }).success).toBe(false);
  });
});

const pool = (name: string, providers: string[]): PoolConfig => ({
  name,
  providers,
  window: { lengthMs: 18_000_000, reset: 'rolling-from-first-use' },
  signalSources: ['retry-after'],
  preferenceRank: 0,
});

describe('validatePoolMembership', () => {
  it('a provider mapped to two pools → { ok: false, offenders: [<name>] }', () => {
    const r = validatePoolMembership([pool('a', ['p1', 'shared']), pool('b', ['p2', 'shared'])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders).toContain('shared');
  });

  it('every provider in exactly one pool across all → { ok: true }', () => {
    const r = validatePoolMembership([pool('a', ['p1', 'p2']), pool('b', ['p3'])]);
    expect(r.ok).toBe(true);
  });
});
