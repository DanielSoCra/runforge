// packages/daemon/src/control-plane/steering/schema.test.ts
//
// IMMOVABLE acceptance contract for the role schema + parser. The declarative
// `.strict()`/rejection cases exercise REAL zod and PASS at handoff; the
// success-path cases (valid → frozen) FAIL (red) until the implementer fills the
// stubbed assemble/freeze step. That mixed red/green is the correct handoff state.
import { describe, it, expect } from 'vitest';
import { parseRole } from './schema.js';
import type { RoleVersion } from './types.js';

/** A stamped RoleVersion the registry would assign — the parser just carries it. */
const version: RoleVersion = {
  roleId: 'product-owner',
  version: 1,
  activatedAt: 1_000,
  digest: 'sha-abc',
};

/** A structurally valid raw role declaration. */
const validRole = {
  id: 'product-owner',
  charter: 'own product shape and priority',
  instructions: 'scan new work items and shape them',
  voice: 'pragmatic product lead',
  capabilityGrant: ['classifier', 'search'],
  referenceKnowledge: ['roadmap', 'vision'],
  routingGrant: ['research', 'operator-proposal'],
  wakeRhythm: { kind: 'interval', everyMs: 3_600_000 },
  perWakingBudget: 5000,
};

describe('parseRole — success path (deep-frozen role)', () => {
  it('a valid SteeringRole parses → ok: true and carries the version', () => {
    const r = parseRole(validRole, version);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role.id).toBe('product-owner');
      expect(r.version).toEqual(version);
    }
  });

  it('the returned role is deep-frozen at top and nested levels', () => {
    const r = parseRole(validRole, version);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.role)).toBe(true);
      expect(Object.isFrozen(r.role.capabilityGrant)).toBe(true);
      expect(Object.isFrozen(r.role.referenceKnowledge)).toBe(true);
      expect(Object.isFrozen(r.role.routingGrant)).toBe(true);
      expect(Object.isFrozen(r.role.wakeRhythm)).toBe(true);
    }
  });

  it('a write to the frozen role does not mutate it', () => {
    const r = parseRole(validRole, version);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const before = r.role.perWakingBudget;
      try {
        (r.role as { perWakingBudget: number }).perWakingBudget = 999_999;
      } catch {
        // strict-mode write throws — acceptable
      }
      expect(r.role.perWakingBudget).toBe(before);
    }
  });
});

describe('parseRole — fail-closed rejections (real zod .strict())', () => {
  it('.strict() rejects an unknown key, offenders names it', () => {
    // A plural typo of routingGrant must reject, never collapse to an empty grant.
    const r = parseRole({ ...validRole, routingGrants: ['research'] }, version);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('routingGrants');
  });

  it('a non-positive perWakingBudget is rejected, offenders names the field', () => {
    const r = parseRole({ ...validRole, perWakingBudget: 0 }, version);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('perWakingBudget');
  });

  it('a missing charter is rejected, offenders names the field', () => {
    const bad = { ...validRole } as Record<string, unknown>;
    delete bad.charter;
    const r = parseRole(bad, version);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('charter');
  });

  it('a malformed interval rhythm (everyMs <= 0) is rejected', () => {
    const r = parseRole(
      { ...validRole, wakeRhythm: { kind: 'interval', everyMs: 0 } },
      version,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('everyMs');
  });

  it('a malformed interval rhythm (non-integer everyMs) is rejected', () => {
    const r = parseRole(
      { ...validRole, wakeRhythm: { kind: 'interval', everyMs: 1.5 } },
      version,
    );
    expect(r.ok).toBe(false);
  });

  it('a malformed cron rhythm (empty expr) is rejected', () => {
    const r = parseRole(
      { ...validRole, wakeRhythm: { kind: 'cron', expr: '' } },
      version,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offenders.join()).toContain('expr');
  });

  it('an unknown wakeRhythm kind is rejected', () => {
    const r = parseRole(
      { ...validRole, wakeRhythm: { kind: 'sundial', everyMs: 1000 } },
      version,
    );
    expect(r.ok).toBe(false);
  });

  it('a valid cron rhythm parses + deep-freezes (storable; cron tick-evaluation is deferred)', () => {
    // A cron-rhythm role declaration STORES fine — freezing is rhythm-agnostic.
    // (Only the cron tick-evaluation in decideWake is deferred — it returns not-due
    // until a pure cron decider lands — so a cron role never auto-wakes yet but is
    // fully declarable.)
    const r = parseRole(
      { ...validRole, wakeRhythm: { kind: 'cron', expr: '0 * * * *' } },
      version,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role.wakeRhythm).toEqual({ kind: 'cron', expr: '0 * * * *' });
      expect(Object.isFrozen(r.role)).toBe(true);
    }
  });
});
