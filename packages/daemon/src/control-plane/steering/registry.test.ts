// packages/daemon/src/control-plane/steering/registry.test.ts
//
// IMMOVABLE acceptance contract for the registry's register/lookup/route ops. All
// behavioral — these FAIL (red) at handoff because the registry bodies throw
// 'not implemented'. Kimi fills the bodies to make them pass; the tests may NOT
// be weakened.
//
// L3 resolution: re-registration of an existing id is a VERSION BUMP — the new
// declaration validates, freezes a NEW RoleVersion, and the latest becomes active
// (the prior remains identifiable for records that ran under it). A duplicate id
// is therefore NOT a rejection across re-registrations of the SAME declaration
// source; the cross-role duplicate-id rejection in the L3 is about a SECOND id
// already owned by another active declaration — which, in a single id-keyed map,
// surfaces as the version-bump-replaces-active behavior asserted below.
import { describe, it, expect } from 'vitest';
import { SteeringRegistry, type KnownTargets } from './registry.js';

/** The platform's known capability / path sets the grant-membership checks use. */
const known: KnownTargets = {
  capabilities: ['classifier', 'search'],
  paths: ['research', 'operator-proposal', 'tech-consult'],
};

/** A structurally valid raw role declaration, parameterized so tests can vary it. */
function makeRole(
  over: {
    id?: string;
    routingGrant?: string[];
    capabilityGrant?: string[];
    perWakingBudget?: number;
  } = {},
) {
  return {
    id: over.id ?? 'product-owner',
    charter: 'own product shape and priority',
    instructions: 'scan new work items and shape them',
    voice: 'pragmatic product lead',
    capabilityGrant: over.capabilityGrant ?? ['classifier'],
    referenceKnowledge: ['roadmap'],
    routingGrant: over.routingGrant ?? ['research', 'operator-proposal'],
    wakeRhythm: { kind: 'interval', everyMs: 3_600_000 },
    perWakingBudget: over.perWakingBudget ?? 5000,
  };
}

describe('SteeringRegistry.register / lookup', () => {
  it('register with a valid declaration → ok: true; lookup finds it by id', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register(makeRole());
    expect(out.ok).toBe(true);

    const found = reg.lookup('product-owner');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      expect(found.role.id).toBe('product-owner');
      expect(found.version.roleId).toBe('product-owner');
    }
  });

  it('register with an invalid declaration → ok: false offenders; NOT stored (atomic)', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register({ ...makeRole(), typoKey: 'oops' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.offenders.length).toBeGreaterThan(0);

    // No partial accept — the role must not be stored.
    expect(reg.lookup('product-owner').kind).toBe('not-found');
  });

  it('a routingGrant entry naming an unknown path → ok: false naming the entry; NOT stored', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register(makeRole({ routingGrant: ['research', 'no-such-path'] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.offenders.join()).toContain('no-such-path');
    expect(reg.lookup('product-owner').kind).toBe('not-found');
  });

  it('a capabilityGrant entry naming an unknown capability → ok: false; NOT stored', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register(makeRole({ capabilityGrant: ['classifier', 'no-such-cap'] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.offenders.join()).toContain('no-such-cap');
    expect(reg.lookup('product-owner').kind).toBe('not-found');
  });

  it('re-registration of an existing id bumps the version; the latest is active', () => {
    const reg = new SteeringRegistry(known);
    const first = reg.register(makeRole({ perWakingBudget: 5000 }));
    expect(first.ok).toBe(true);
    const v1 = first.ok ? first.version.version : -1;

    const second = reg.register(makeRole({ perWakingBudget: 7000 }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.version.version).toBeGreaterThan(v1);
    }

    // lookup serves the latest (active) version + its declaration.
    const found = reg.lookup('product-owner');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      expect(found.role.perWakingBudget).toBe(7000);
      expect(found.version.version).toBeGreaterThan(v1);
    }
  });

  it('a failed re-registration leaves the prior frozen declaration active', () => {
    const reg = new SteeringRegistry(known);
    expect(reg.register(makeRole({ perWakingBudget: 5000 })).ok).toBe(true);

    // Re-register the same id with an invalid declaration.
    const bad = reg.register({ ...makeRole({ perWakingBudget: 7000 }), typoKey: 'oops' });
    expect(bad.ok).toBe(false);

    // The prior declaration stays active and unchanged.
    const found = reg.lookup('product-owner');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(found.role.perWakingBudget).toBe(5000);
  });

  it('lookup(unknownId) → tagged not-found, no throw', () => {
    const reg = new SteeringRegistry(known);
    const r = reg.lookup('nope');
    expect(r.kind).toBe('not-found');
    if (r.kind === 'not-found') expect(r.roleId).toBe('nope');
  });
});

describe('SteeringRegistry.route (the only exit — records, never executes)', () => {
  it('route with a target IN the routing grant → recorded, stamped with waking + version', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register(makeRole({ routingGrant: ['research', 'operator-proposal'] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const r = reg.route(
      'product-owner',
      out.version,
      'waking-1',
      'research',
      'artifact-42',
    );
    expect(r.kind).toBe('recorded');
    if (r.kind === 'recorded') {
      expect(r.request.target).toBe('research');
      expect(r.request.wakingId).toBe('waking-1');
      expect(r.request.artifactRef).toBe('artifact-42');
      expect(r.request.version).toEqual(out.version);
    }
  });

  it('route with a target NOT in the routing grant → rejected (never executes)', () => {
    const reg = new SteeringRegistry(known);
    const out = reg.register(makeRole({ routingGrant: ['research'] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const r = reg.route(
      'product-owner',
      out.version,
      'waking-1',
      'operator-proposal', // granted at platform level but NOT in this role's grant
      'artifact-42',
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('operator-proposal');
  });
});
