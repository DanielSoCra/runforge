// packages/daemon/src/control-plane/steering/registry.ts
//
// Steering-Role Registry — the in-memory record (STACK-AC-STEERING).
//
// declare → validate → freeze → lookup, plus the version-attribution map, the
// Waking lifecycle, and the routing-grant check. I/O (config load, DB persist)
// is the edge this calls out to — never inside parseRole or the deciders. Bodies
// are STUBBED to throw 'not implemented'; the implementer (Kimi) fills them to
// satisfy the immovable acceptance tests in registry.test.ts. The tests may NOT
// be weakened.
//
// Fail-closed discriminated-union outcomes — never throw on a config/policy
// question (lookups → tagged not-found; route → { kind:'rejected' }; register →
// { ok:false; offenders }). Exceptions are reserved for programmer error. The
// registry NEVER executes, merges, or starts implementation — route records a
// RouteRequest and hands it off, nothing more.

import { createHash } from 'node:crypto';
import {
  SteeringRoleSchema,
  zodOffenders,
  parseRole,
} from './schema.js';
import type {
  SteeringRole,
  RoleVersion,
  Waking,
  RegistrationOutcome,
  LookupResult,
  RouteResult,
  RouteRequest,
} from './types.js';

/**
 * The platform-supplied sets the cross-subsystem grant-membership checks run
 * against: every `capabilityGrant` entry must name a known capability and every
 * `routingGrant` entry must name a known target path, else the whole declaration
 * is rejected (L2 error handling). Supplied by the Control Plane at construction.
 */
export interface KnownTargets {
  capabilities: string[];
  paths: string[];
}

/**
 * The in-memory Steering registry: holds the active frozen role keyed by id, the
 * version-attribution map (re-registration bumps the version; the prior remains
 * identifiable for records that ran under it), and the open Wakings. The
 * cross-role duplicate-id check and the grant-membership checks live in
 * `register` (the schema cannot see other roles or the platform's known sets).
 * The persistence edge (Postgres) is called here, never inside parseRole or the
 * deciders.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${pairs.join(',')}}`;
}

function digestRole(data: SteeringRole): string {
  // A BOUNDED content hash — never the stringified declaration itself (which would
  // leak/duplicate the full charter, instructions, and grants into every persisted
  // or surfaced RoleVersion). Deterministic: no clock, no randomness.
  return `sha256-${createHash('sha256').update(stableStringify(data)).digest('hex')}`;
}

export class SteeringRegistry {
  private readonly knownCapabilities: ReadonlySet<string>;
  private readonly knownPaths: ReadonlySet<string>;
  private readonly roles = new Map<
    string,
    { role: Readonly<SteeringRole>; version: RoleVersion }
  >();
  private readonly wakings = new Map<string, Waking>();
  private readonly nextVersion = new Map<string, number>();
  private activationClock = 0;
  private wakingSeq = 0;

  /**
   * @param known the platform's known-capabilities / known-paths sets the
   *        grant-membership checks validate against. A grant entry naming an
   *        unknown target is an offender and rejects the whole declaration.
   */
  constructor(known: KnownTargets = { capabilities: [], paths: [] }) {
    this.knownCapabilities = new Set(known.capabilities);
    this.knownPaths = new Set(known.paths);
  }

  /**
   * Parse + validate + freeze + store one role's declaration, keyed by id.
   * Atomic and fail-closed: any structural error (unknown key, missing charter,
   * a routing-grant / capability-grant entry naming an unknown target, a
   * non-positive budget, a malformed rhythm) OR a cross-role duplicate id rejects
   * the whole declaration naming every offender, and NOTHING is stored. On a
   * re-register of an existing id, success freezes a NEW RoleVersion (the version
   * increments and the latest becomes active); on failure the prior frozen
   * declaration stays active.
   */
  register(raw: unknown): RegistrationOutcome {
    const parsed = SteeringRoleSchema.safeParse(raw);
    const rawObj =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    // Collect EVERY offender in one pass — schema errors AND grant-membership
    // errors — so a declaration with both is rejected completely (the operator
    // fixes every class at once, not one per reload). Grant checks read the
    // validated data when the schema passed, else best-effort on the raw arrays.
    const grantSource: { capabilityGrant?: unknown; routingGrant?: unknown } =
      parsed.success ? parsed.data : rawObj;
    const offenders: string[] = parsed.success ? [] : zodOffenders(parsed.error);

    const caps = grantSource.capabilityGrant;
    if (Array.isArray(caps)) {
      for (const c of caps) {
        if (typeof c === 'string' && this.knownCapabilities.has(c) === false) {
          offenders.push(`capability '${c}' is not a known capability`);
        }
      }
    }
    const paths = grantSource.routingGrant;
    if (Array.isArray(paths)) {
      for (const p of paths) {
        if (typeof p === 'string' && this.knownPaths.has(p) === false) {
          offenders.push(`path '${p}' is not a known routing path`);
        }
      }
    }

    if (offenders.length > 0 || parsed.success === false) {
      return { ok: false, offenders };
    }

    const data = parsed.data;
    const roleId = data.id;
    const versionNumber = this.nextVersion.get(roleId) ?? 1;
    this.nextVersion.set(roleId, versionNumber + 1);

    const version: RoleVersion = {
      roleId,
      version: versionNumber,
      activatedAt: (this.activationClock += 1),
      digest: digestRole(data),
    };

    const outcome = parseRole(raw, version);
    if (outcome.ok === true) {
      this.roles.set(roleId, { role: outcome.role, version: outcome.version });
    }
    return outcome;
  }

  /** Look up the active (latest) frozen role + its RoleVersion, or tagged not-found (never throws). */
  lookup(roleId: string): LookupResult {
    const active = this.roles.get(roleId);
    if (active === undefined) {
      return { kind: 'not-found', roleId };
    }
    return { kind: 'found', role: active.role, version: active.version };
  }

  /**
   * Open a Waking for a role, bound to the role's CURRENT RoleVersion and the
   * declared per-waking budget. The Waking pins that version for its whole life
   * (the in-flight pin — a later re-registration must not retro-stamp it).
   * `now` is passed in (no clock read). Tagged not-found on an unknown role.
   */
  openWaking(roleId: string, now: number): LookupResult | Waking {
    const found = this.lookup(roleId);
    if (found.kind === 'not-found') {
      return found;
    }

    const waking: Waking = {
      id: `w-${(this.wakingSeq += 1)}`,
      roleId,
      version: found.version,
      role: found.role, // pin the frozen declaration for the waking's whole life
      openedAt: now,
    };
    this.wakings.set(waking.id, waking);
    return waking;
  }

  /**
   * Finalize an open Waking, advancing the role's last-waking marker so the next
   * scan reads only what is new. `now` is passed in (no clock read).
   */
  closeWaking(wakingId: string, now: number): Waking {
    const waking = this.wakings.get(wakingId);
    if (waking === undefined) {
      throw new Error(`waking '${wakingId}' not found`);
    }
    const closed: Waking = { ...waking, closedAt: now };
    this.wakings.set(wakingId, closed);
    return closed;
  }

  /**
   * The ONLY exit: check `target` against the role's routing grant and record a
   * RouteRequest stamped with the originating waking id + RoleVersion, or reject.
   * A granted target returns `{ kind: 'recorded'; request }`; an ungranted target
   * returns `{ kind: 'rejected'; reason }` and records nothing dispatched (the
   * rejection is itself recorded against the waking). NEVER executes the workflow.
   */
  route(wakingId: string, target: string, artifactRef: string): RouteResult {
    // Authorize against the WAKING's PINNED role/version — never the registry's
    // current role and never a caller-supplied version. A waking opened under v1
    // routes by v1's grants even if the role was re-registered to v2 mid-waking.
    const waking = this.wakings.get(wakingId);
    if (waking === undefined) {
      return { kind: 'rejected', reason: `waking '${wakingId}' not found` };
    }
    if (waking.closedAt !== undefined) {
      return { kind: 'rejected', reason: `waking '${wakingId}' is already closed` };
    }

    if (waking.role.routingGrant.includes(target) === false) {
      return {
        kind: 'rejected',
        reason: `target '${target}' is outside the role's routing grant`,
      };
    }

    const request: RouteRequest = {
      wakingId,
      version: waking.version,
      target,
      artifactRef,
    };
    return { kind: 'recorded', request };
  }
}

/**
 * Factory mirror of the deployment-registry / lane-engine convention. The known
 * capability / path sets may be supplied here (else the grant-membership checks
 * run against empty sets and any non-empty grant is an offender).
 */
export function createSteeringRegistry(known?: KnownTargets): SteeringRegistry {
  return new SteeringRegistry(known);
}

// Re-export so consumers can stamp a RoleVersion / construct a SteeringRole shape
// from one import site (the composition rule). No runtime cost.
export type { SteeringRole, RoleVersion };
